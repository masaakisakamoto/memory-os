/**
 * eval-run — evaluate a real handoff artifact from logs/runs/.
 *
 * Usage:
 *   tsx evals/eval-run.ts [RUN_ID]
 *
 *   RUN_ID: the directory name under logs/runs/ (e.g., 20260402-002038-proj_memory_os).
 *           Defaults to the most recent run directory when omitted.
 *
 * Reads:  logs/runs/<RUN_ID>/handoff-context.json
 * Writes: logs/runs/<RUN_ID>/handoff-eval.json   (overwrites if present)
 * Prints: scored category table + any failures to stdout.
 *
 * Evaluator mode:
 *   state_aware — when DATABASE_URL is set, uses evaluateHandoffWithState(db, ctx).
 *                 Detects missing_policy, missing_project_state, and other DB-authoritative
 *                 mismatches. Writes evaluator_mode: "state_aware" into handoff-eval.json.
 *   pure        — fallback when DATABASE_URL is unset or the DB connection fails.
 *                 Scores artifact text only (8 rubric categories). Cannot detect state
 *                 mismatches. Writes evaluator_mode: "pure" into handoff-eval.json.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { evaluateHandoff, evaluateHandoffWithState } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResult, HandoffEvalResultV2 } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LOGS_DIR = resolve(REPO_ROOT, 'logs', 'runs');

// ---------------------------------------------------------------------------
// Resolve run directory
// ---------------------------------------------------------------------------

function findLatestRun(): string {
  if (!existsSync(LOGS_DIR)) {
    throw new Error(`logs/runs/ does not exist at ${LOGS_DIR}`);
  }
  const dirs = readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()          // lexicographic — YYYYMMDD prefix sorts chronologically
    .reverse();
  if (dirs.length === 0) throw new Error('No run directories found in logs/runs/');
  return dirs[0];
}

const runId = process.argv[2] ?? findLatestRun();
const runDir = resolve(LOGS_DIR, runId);

if (!existsSync(runDir)) {
  console.error(`Run directory not found: ${runDir}`);
  process.exit(1);
}

const contextPath = resolve(runDir, 'handoff-context.json');

if (!existsSync(contextPath)) {
  console.error(`handoff-context.json not found in ${runDir}`);
  console.error('Hint: run the worker rebuild-context-cache job to generate context artifacts.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Evaluate — state-aware when DATABASE_URL is available, pure as fallback
// ---------------------------------------------------------------------------

const ctx: HandoffContext = JSON.parse(readFileSync(contextPath, 'utf8'));
const evalPath = resolve(runDir, 'handoff-eval.json');

(async () => {
  let result: HandoffEvalResult | HandoffEvalResultV2;
  let evaluatorMode: 'state_aware' | 'pure' = 'pure';

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = new Pool({ connectionString: dbUrl });
    try {
      result = await evaluateHandoffWithState(db, ctx);
      evaluatorMode = 'state_aware';
    } catch {
      // DB unavailable — fall back to pure (logs warning below)
      result = evaluateHandoff(ctx);
    } finally {
      await db.end().catch(() => {});
    }
    if (evaluatorMode === 'pure') {
      console.warn('  Warning: DATABASE_URL set but DB connection failed — fell back to pure evaluator.');
      console.warn('  State mismatches (missing_policy, missing_project_state) will NOT be detected.');
    }
  } else {
    result = evaluateHandoff(ctx);
  }

  // Write result with evaluator_mode annotation
  writeFileSync(evalPath, JSON.stringify({ ...result, evaluator_mode: evaluatorMode }, null, 2));

  // ---------------------------------------------------------------------------
  // Print summary
  // ---------------------------------------------------------------------------

  const statusLabel = result.pass
    ? `PASS  (${result.score_total}/${result.score_max})`
    : `FAIL  (${result.score_total}/${result.score_max})`;

  const bar = (score: number, max: number): string => {
    if (score === max)  return '✓';
    if (score === 0)    return '✗';
    return '~';
  };

  const modeTag = evaluatorMode === 'state_aware' ? '  [state-aware]' : '  [pure — no DB]';

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  Handoff Eval  ·  ${runId}`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Context : ${ctx.context_id}`);
  console.log(`  Project : ${ctx.project_id ?? '(none)'}`);
  console.log(`  Mode    :${modeTag}`);
  console.log(`  Status  : ${statusLabel}  (threshold ${result.pass_threshold})`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Category                  Score  Max`);
  console.log(`  ─────────────────────────────────────`);

  for (const cat of result.categories) {
    const icon = bar(cat.score, cat.max);
    const name = cat.name.padEnd(26);
    const score = String(cat.score).padStart(3);
    const max = String(cat.max).padStart(4);
    console.log(`  ${icon} ${name}${score} /${max}`);
  }

  console.log(`  ─────────────────────────────────────`);
  console.log(`    TOTAL                     ${result.score_total} / ${result.score_max}`);

  if (result.failures.length > 0) {
    console.log(`\n  Failures (${result.failures.length}):`);
    for (const f of result.failures) {
      console.log(`    · ${f}`);
    }
  }

  if (result.recommendations.length > 0) {
    console.log(`\n  Recommendations:`);
    for (const r of result.recommendations) {
      console.log(`    → ${r}`);
    }
  }

  const notes = result.categories.flatMap(c =>
    c.notes.filter(n => n.includes('(-')).map(n => `[${c.name}] ${n}`)
  );
  if (notes.length > 0) {
    console.log(`\n  Deductions:`);
    for (const n of notes) {
      console.log(`    · ${n}`);
    }
  }

  // Print state mismatches when state-aware
  const v2 = result as Partial<HandoffEvalResultV2>;
  if (v2.state_consistency && v2.state_consistency.mismatches.length > 0) {
    const mismatches = v2.state_consistency.mismatches;
    console.log(`\n  State Mismatches (${mismatches.length}):`);
    for (const m of mismatches) {
      const fixTag = m.auto_fixable ? ' [auto_fixable]' : '';
      console.log(`    · [${m.severity}] ${m.mismatch_type}${fixTag}`);
      console.log(`      ${m.detail}`);
    }
    const autoFixCount = mismatches.filter(m => m.auto_fixable).length;
    if (autoFixCount > 0) {
      console.log(`\n  Hint: ${autoFixCount} auto_fixable mismatch(es) — run:`);
      console.log(`    worker rebuild-context-cache --repair --run=${runId}`);
    }
  }

  console.log(`\n  Eval written → ${evalPath}`);
  console.log(`──────────────────────────────────────────────\n`);
})().catch(err => {
  console.error('eval-run error:', err);
  process.exit(1);
});
