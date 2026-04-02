/**
 * rebuild-context-cache — generates and persists handoff context artifacts.
 *
 * Normal mode (default):
 *   For each active project, produces:
 *     logs/runs/<RUN_ID>/run.json              — run metadata
 *     logs/runs/<RUN_ID>/handoff-context.json  — full context (matches context.schema.json)
 *     logs/runs/<RUN_ID>/handoff-context.md    — human-readable for next-chat inspection
 *     logs/runs/<RUN_ID>/handoff-eval.json     — quality evaluation (score, pass/fail, failures)
 *
 * Repair mode (--repair):
 *   Reads handoff-eval.json from the latest run (or --run=<RUN_ID>), collects all
 *   auto_fixable mismatches, regenerates the handoff using DB-authoritative state, and
 *   re-evaluates. Writes repaired artifacts to logs/runs/<RUN_ID>/repaired/:
 *     repaired/handoff-context.json   — regenerated context
 *     repaired/handoff-context.md     — regenerated markdown
 *     repaired/handoff-eval.json      — post-repair evaluation
 *     repaired/handoff-repair.json    — repair report with before/after diff
 *
 * RUN_ID format: YYYYMMDD-HHmmss-<project_id>
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { generateHandoffContext, evaluateHandoffWithState } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResultV2, StateMismatch } from '@memory-os/core-context';

// Resolve logs/runs/ relative to the monorepo root.
// At runtime (CJS), __dirname is apps/worker/dist/jobs — walk up 4 levels.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const LOGS_DIR = resolve(REPO_ROOT, 'logs', 'runs');

function runId(projectId: string): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const ts = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${ts}-${safe}`;
}

function toMarkdown(ctx: HandoffContext): string {
  const lines: string[] = [];

  lines.push('# Handoff Context');
  lines.push('');
  lines.push(`**Project:** ${ctx.project_id ?? '(none)'}`);
  lines.push(`**Generated:** ${ctx.generated_at}`);
  lines.push(`**Intent:** ${ctx.intent}`);
  lines.push(`**Tokens:** ${ctx.token_budget.used} / ${ctx.token_budget.target} (compression: ${ctx.token_budget.compression_level})`);
  lines.push('');
  lines.push('---');

  // Sections ordered by handoff priority (matches scope-planner HANDOFF_SCOPE)
  const sections: Array<{ key: keyof typeof ctx.sections; label: string }> = [
    { key: 'relationship',            label: 'Relationship' },
    { key: 'global_policies',         label: 'Global Policies' },
    { key: 'active_project',          label: 'Active Project' },
    { key: 'relevant_decisions',      label: 'Relevant Decisions' },
    { key: 'strategic_next_actions',  label: 'Strategic Next Actions' },
    { key: 'operational_next_actions',label: 'Operational Next Actions' },
    { key: 'open_loops',              label: 'Open Loops' },
    { key: 'recent_episodes',         label: 'Recent Episodes' },
    { key: 'identity',                label: 'Identity' },
    { key: 'evidence',                label: 'Evidence' },
    { key: 'procedures',              label: 'Procedures' },
  ];

  for (const { key, label } of sections) {
    lines.push('');
    lines.push(`## ${label}`);
    const value = ctx.sections[key];
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) {
      lines.push('*(empty)*');
    } else {
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
  }

  if (ctx.sections.task_frame) {
    lines.push('');
    lines.push('## Task Frame');
    lines.push(ctx.sections.task_frame);
  }

  lines.push('');
  lines.push('---');
  lines.push(`*Source memories: ${ctx.source_memories.length} | Context ID: ${ctx.context_id}*`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Repair mode types
// ---------------------------------------------------------------------------

interface MismatchSummary {
  mismatch_type: string;
  db_id: string;
  detail: string;
}

interface HandoffRepairReport {
  repair_id: string;
  run_id: string;
  repaired_at: string;
  project_id: string;
  /** skipped=no auto_fixable mismatches; success=all resolved; partial=some resolved; no_change=none resolved */
  repair_status: 'skipped' | 'success' | 'partial' | 'no_change';
  auto_fixable_found: number;
  resolved: MismatchSummary[];
  unresolved: MismatchSummary[];
  before: {
    eval_id: string;
    score_total: number;
    pass: boolean;
    mismatch_count: number;
    auto_fixable_mismatches: MismatchSummary[];
  };
  after: {
    eval_id: string;
    context_id: string;
    score_total: number;
    pass: boolean;
    mismatch_count: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Repair mode helpers
// ---------------------------------------------------------------------------

function findLatestRunDir(): string {
  if (!existsSync(LOGS_DIR)) throw new Error(`logs/runs/ not found at ${LOGS_DIR}`);
  const dirs = readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse();
  if (dirs.length === 0) throw new Error('No run directories found in logs/runs/');
  return dirs[0];
}

function mismatchKey(m: MismatchSummary): string {
  return `${m.mismatch_type}::${m.db_id}`;
}

export async function repairContextCacheJob(db: Pool, runId?: string): Promise<void> {
  const rid = runId ?? findLatestRunDir();
  const runDir = resolve(LOGS_DIR, rid);

  if (!existsSync(runDir)) {
    console.error(`Run directory not found: ${runDir}`);
    process.exit(1);
  }

  const evalPath = resolve(runDir, 'handoff-eval.json');

  const runMetaPath = resolve(runDir, 'run.json');
  if (!existsSync(runMetaPath)) {
    console.error(`run.json not found in ${runDir}`);
    process.exit(1);
  }

  // Read the existing context — NOT the stale handoff-eval.json.
  // The stale eval may have been produced by the pure evaluator (no state_consistency block),
  // which would make auto_fixable mismatches invisible to the repair loop.
  const contextPath = resolve(runDir, 'handoff-context.json');
  if (!existsSync(contextPath)) {
    console.error(`handoff-context.json not found in ${runDir}`);
    console.error('Hint: run rebuild-context-cache (without --repair) first to generate context artifacts.');
    process.exit(1);
  }

  const runMeta: { project_id: string } = JSON.parse(readFileSync(runMetaPath, 'utf8'));
  const existingCtx: HandoffContext = JSON.parse(readFileSync(contextPath, 'utf8'));

  console.log(`\nRepair mode — run: ${rid}`);
  console.log(`  project : ${runMeta.project_id}`);

  // Run a fresh DB-authoritative evaluation on the existing context.
  // This is the source of truth for auto_fixable mismatches — never trust stale handoff-eval.json.
  console.log('  Running fresh state-aware pre-repair evaluation...');
  const freshPreEval = await evaluateHandoffWithState(db, existingCtx);

  // Overwrite handoff-eval.json with the authoritative state-aware result.
  // After this point, handoff-eval.json always reflects DB-consistent state.
  writeFileSync(evalPath, JSON.stringify(freshPreEval, null, 2));

  console.log(`  before  : score=${freshPreEval.score_total}/${freshPreEval.score_max} pass=${freshPreEval.pass}`);

  const autoFixable: StateMismatch[] = freshPreEval.state_consistency.mismatches.filter(m => m.auto_fixable);

  const repairId = `repair_${randomBytes(6).toString('hex')}`;
  const repairedAt = new Date().toISOString();

  const beforeSummary: HandoffRepairReport['before'] = {
    eval_id: freshPreEval.eval_id,
    score_total: freshPreEval.score_total,
    pass: freshPreEval.pass,
    mismatch_count: freshPreEval.state_consistency.mismatches.length,
    auto_fixable_mismatches: autoFixable.map(m => ({
      mismatch_type: m.mismatch_type,
      db_id: m.db_id,
      detail: m.detail,
    })),
  };

  if (autoFixable.length === 0) {
    const report: HandoffRepairReport = {
      repair_id: repairId,
      run_id: rid,
      repaired_at: repairedAt,
      project_id: runMeta.project_id,
      repair_status: 'skipped',
      auto_fixable_found: 0,
      resolved: [],
      unresolved: [],
      before: beforeSummary,
      after: null,
    };

    const repairedDir = resolve(runDir, 'repaired');
    mkdirSync(repairedDir, { recursive: true });
    writeFileSync(resolve(repairedDir, 'handoff-repair.json'), JSON.stringify(report, null, 2));

    console.log('  status  : skipped — no auto_fixable mismatches detected');
    console.log(`  report  → ${repairedDir}/handoff-repair.json`);
    return;
  }

  console.log(`  auto_fixable mismatches: ${autoFixable.length}`);
  for (const m of autoFixable) {
    console.log(`    [${m.mismatch_type}] ${m.detail}`);
    console.log(`      fix: ${m.fix_hint}`);
  }

  // Regenerate context using DB-authoritative state (this IS the repair)
  console.log('\n  Regenerating context from DB...');
  const repairedContext = await generateHandoffContext(db, {
    intent: 'handoff',
    project_id: runMeta.project_id,
    token_budget: 2000,
  });

  // Re-evaluate with live DB consistency checks
  const repairedEval = await evaluateHandoffWithState(db, repairedContext);
  const repairedMismatches = repairedEval.state_consistency.mismatches;

  // Diff: which auto_fixable mismatches were resolved?
  const remainingKeys = new Set(
    repairedMismatches.map(m => `${m.mismatch_type}::${m.db_id}`)
  );

  const resolved: MismatchSummary[] = [];
  const unresolved: MismatchSummary[] = [];

  for (const m of autoFixable) {
    const summary: MismatchSummary = { mismatch_type: m.mismatch_type, db_id: m.db_id, detail: m.detail };
    if (remainingKeys.has(mismatchKey(summary))) {
      unresolved.push(summary);
    } else {
      resolved.push(summary);
    }
  }

  const repairStatus: HandoffRepairReport['repair_status'] =
    resolved.length === autoFixable.length ? 'success' :
    resolved.length === 0                  ? 'no_change' : 'partial';

  const report: HandoffRepairReport = {
    repair_id: repairId,
    run_id: rid,
    repaired_at: repairedAt,
    project_id: runMeta.project_id,
    repair_status: repairStatus,
    auto_fixable_found: autoFixable.length,
    resolved,
    unresolved,
    before: beforeSummary,
    after: {
      eval_id: repairedEval.eval_id,
      context_id: repairedContext.context_id,
      score_total: repairedEval.score_total,
      pass: repairedEval.pass,
      mismatch_count: repairedMismatches.length,
    },
  };

  // Write all repaired artifacts into <RUN_DIR>/repaired/
  const repairedDir = resolve(runDir, 'repaired');
  mkdirSync(repairedDir, { recursive: true });

  writeFileSync(resolve(repairedDir, 'handoff-context.json'), JSON.stringify(repairedContext, null, 2));
  writeFileSync(resolve(repairedDir, 'handoff-context.md'), toMarkdown(repairedContext));
  writeFileSync(resolve(repairedDir, 'handoff-eval.json'), JSON.stringify(repairedEval, null, 2));
  writeFileSync(resolve(repairedDir, 'handoff-repair.json'), JSON.stringify(report, null, 2));

  const afterScore = `${repairedEval.score_total}/${repairedEval.score_max}`;
  console.log(`  after   : score=${afterScore} pass=${repairedEval.pass}`);
  console.log(`  status  : ${repairStatus.toUpperCase()}`);
  if (resolved.length > 0) {
    console.log(`  resolved (${resolved.length}):`);
    for (const r of resolved) console.log(`    ✓ [${r.mismatch_type}] ${r.detail}`);
  }
  if (unresolved.length > 0) {
    console.log(`  unresolved (${unresolved.length}):`);
    for (const u of unresolved) console.log(`    ✗ [${u.mismatch_type}] ${u.detail}`);
  }
  console.log(`\n  artifacts → ${repairedDir}/`);
  console.log('    handoff-context.json');
  console.log('    handoff-context.md');
  console.log('    handoff-eval.json');
  console.log('    handoff-repair.json');
}

export async function rebuildContextCacheJob(db: Pool, projectId?: string): Promise<void> {
  let projectIds: string[];

  if (projectId) {
    projectIds = [projectId];
  } else {
    const { rows } = await db.query(
      `SELECT DISTINCT project_id FROM memories WHERE status = 'active' AND project_id IS NOT NULL`
    );
    projectIds = rows.map((r: { project_id: string }) => r.project_id);
  }

  if (projectIds.length === 0) {
    console.log('No active projects with committed memories found.');
    console.log('Hint: ensure memories have project_id set (commit populates it from the session).');
    return;
  }

  console.log(`Rebuilding context for ${projectIds.length} project(s)...`);

  for (const pid of projectIds) {
    const context = await generateHandoffContext(db, {
      intent: 'handoff',
      project_id: pid,
      token_budget: 2000,
    });

    const rid = runId(pid);
    const runDir = resolve(LOGS_DIR, rid);
    mkdirSync(runDir, { recursive: true });

    // run.json — run metadata
    const runMeta = {
      run_id: rid,
      project_id: pid,
      context_id: context.context_id,
      generated_at: context.generated_at,
      token_budget: context.token_budget,
      source_memory_count: context.source_memories.length,
    };
    writeFileSync(resolve(runDir, 'run.json'), JSON.stringify(runMeta, null, 2));

    // handoff-context.json — full context document (matches context.schema.json)
    writeFileSync(resolve(runDir, 'handoff-context.json'), JSON.stringify(context, null, 2));

    // handoff-context.md — human-readable for next-chat inspection
    writeFileSync(resolve(runDir, 'handoff-context.md'), toMarkdown(context));

    // handoff-eval.json — quality evaluation (with live DB consistency checks)
    const evalResult = await evaluateHandoffWithState(db, context);
    writeFileSync(resolve(runDir, 'handoff-eval.json'), JSON.stringify(evalResult, null, 2));

    const evalStatus = evalResult.pass
      ? `PASS (${evalResult.score_total}/${evalResult.score_max})`
      : `FAIL (${evalResult.score_total}/${evalResult.score_max}) — ${evalResult.failures.length} failure(s)`;

    console.log(`  [${pid}] run=${rid}`);
    console.log(`    tokens: ${context.token_budget.used}/${context.token_budget.target}`);
    console.log(`    strategic_next_actions: ${context.sections.strategic_next_actions.length}`);
    console.log(`    operational_next_actions: ${context.sections.operational_next_actions.length}`);
    console.log(`    open_loops: ${context.sections.open_loops.length}`);
    console.log(`    eval: ${evalStatus}`);
    if (!evalResult.pass && evalResult.failures.length > 0) {
      for (const f of evalResult.failures) console.log(`      - ${f}`);
    }
    console.log(`    artifacts: ${runDir}/`);
  }

  console.log('Context cache rebuild complete.');
}
