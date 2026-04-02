/**
 * Handoff generator — produces a complete handoff context document.
 *
 * Assembly pipeline:
 *   1. resolveIntent         — determine intent, role, project_id
 *   2. planScope             — allocate token budget across sections
 *   3. assembleContext       — fetch memories from DB (priority-ordered, deduplicated, fallbacks)
 *   4. deriveProjectFallback — if active_project is empty, generate minimal summary
 *                              from project_state / decision / episode only (not identity/policy)
 *   5. deriveDecisionsFallback — if relevant_decisions is empty, synthesize from policy/
 *                              project_state memories that contain decision signals; runs
 *                              outside assembler to bypass cross-section deduplication
 *   6. deriveStrategicNextActions — what the project is heading toward (continuation signals,
 *                              goal/decision content, v1 roadmap items)
 *   7. deriveOperationalNextActions — immediate tasks: pending proposals, unresolved episodes
 *   8. deriveOpenLoops       — deferred threads from decisions and project content
 *   9. compress and return
 *
 * All derivation is deterministic — no LLM calls.
 *
 * Section → memory_type mapping (strict):
 *   identity           ← identity
 *   relationship       ← relationship (episode fallback only)
 *   global_policies    ← policy
 *   active_project     ← project_state (deriveProjectFallback: decision, episode)
 *   relevant_decisions ← decision (deriveDecisionsFallback: policy/project_state signals)
 *   recent_episodes    ← episode
 *   evidence           ← evidence
 *   procedures         ← procedure
 *   task_frame         ← handoff_summary
 *   strategic/operational_next_actions, open_loops ← synthesized
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { resolveIntent } from './intent-resolver';
import { planScope } from './scope-planner';
import { assembleContext } from './assembler';
import type { AssembledContext } from './assembler';
import { determineCompressionLevel, compressContent } from './compressor';

export interface HandoffRequest {
  intent?: string;
  role?: string;
  project_id?: string | null;
  query?: string;
  token_budget?: number;
}

export interface HandoffContext {
  context_id: string;
  intent: string;
  role: string;
  project_id: string | null;
  generated_at: string;
  sections: {
    identity: string[];
    relationship: string[];
    global_policies: string[];
    active_project: string[];
    relevant_decisions: string[];
    procedures: string[];
    recent_episodes: string[];
    evidence: string[];
    task_frame: string | null;
    strategic_next_actions: string[];
    operational_next_actions: string[];
    open_loops: string[];
  };
  token_budget: {
    target: number;
    used: number;
    compression_level: 'none' | 'light' | 'aggressive';
  };
  source_memories: Array<{ memory_id: string; score: number; trust_level: string }>;
}

// --- Derivation helpers ---

/**
 * Fallback project summary when no project_state memories exist in the assembled context.
 * Restricted to project_state, decision, episode — never identity or policy, as those
 * belong to their own sections and mixing them here creates misleading active_project content.
 */
async function deriveProjectFallback(
  db: Pool,
  projectId: string | null
): Promise<string[]> {
  if (!projectId) return [];

  const { rows } = await db.query<{ content: string; summary: string | null; memory_type: string }>(
    `SELECT content, summary, memory_type FROM memories
     WHERE project_id = $1 AND status = 'active'
       AND memory_type IN ('project_state', 'decision', 'episode')
     ORDER BY
       CASE memory_type
         WHEN 'project_state' THEN 1
         WHEN 'decision'      THEN 2
         WHEN 'episode'       THEN 3
       END,
       importance_score DESC NULLS LAST
     LIMIT 3`,
    [projectId]
  );

  if (rows.length === 0) {
    return [`Project ${projectId}: no committed state recorded yet. Memories pending approval.`];
  }

  return rows.map(r => r.summary ?? r.content);
}

/**
 * Synthesize relevant_decisions when no decision-type memories were assembled.
 *
 * Runs outside the assembler to bypass cross-section deduplication — decisions may
 * legitimately overlap with global_policies content. Filters committed policy and
 * project_state memories for decision signals (decided, deferred, chosen, etc.).
 */
async function deriveDecisionsFallback(
  db: Pool,
  projectId: string | null
): Promise<string[]> {
  const decisionSignal = /決定|decided|deferred|採用|chosen|defer|v1以降|selected|only.*v0|v0.*only/i;

  const { rows } = await db.query<{ content: string; summary: string | null }>(
    `SELECT content, summary FROM memories
     WHERE status = 'active'
       AND memory_type IN ('policy', 'project_state')
       AND trust_level = ANY(ARRAY['t3_committed', 't4_human', 't5_canonical'])
       AND ($1::text IS NULL OR project_id = $1 OR project_id IS NULL)
     ORDER BY importance_score DESC NULLS LAST
     LIMIT 10`,
    [projectId]
  );

  const decisions: string[] = [];
  for (const row of rows) {
    const text = row.summary ?? row.content;
    if (decisionSignal.test(text) && !decisions.includes(text)) {
      decisions.push(text);
    }
    if (decisions.length >= 4) break;
  }
  return decisions;
}

/**
 * Transforms a raw decision sentence into a forward-looking action statement.
 *
 * Rules by semantic class:
 *   [Goal]      → "Pursue: <goal object>"
 *                 Extracts the object of "を目指" if present; otherwise strips "Product goal は".
 *   [Priority]  → "Prioritize: <focus content>"
 *                 Extracts what follows "次の重点は[、]" and strips trailing "である".
 *   [Execution] → "Proceed in phases: <core>"
 *                 Keeps technical notation (A→B, pipeline) intact.
 *   [Direction] → "Maintain: <constraint>"
 *                 Extracts subject of "を厳守" if present; otherwise uses full sentence.
 *
 * Decisions are never copied verbatim — they are always prefixed with an action verb
 * and trimmed to ≤100 chars. Relevant Decisions remains unchanged.
 */
function transformDecisionToAction(text: string, semanticClass: string): string {
  const cap = (s: string) => (s.length > 100 ? s.substring(0, 97) + '...' : s);
  // Strip common trailing punctuation before transforming
  const clean = text.replace(/[。．、,]\s*$/, '').trim();

  if (semanticClass === '[Goal]') {
    // "X を目指すが、..." → extract X
    const goalObj = clean.match(/(.+?)を目指/);
    if (goalObj) {
      // Also strip leading "Product goal は" or similar label
      const core = goalObj[1].replace(/^.+?\s+goal\s+は\s*/i, '').trim();
      return cap(`Pursue: ${core}`);
    }
    // Fallback: strip "Product goal は" prefix if no verb found
    const stripped = clean.replace(/^.+?\s+goal\s+は\s*/i, '').trim();
    return cap(`Pursue: ${stripped || clean}`);
  }

  if (semanticClass === '[Priority]') {
    // "次の重点は、X である" → extract X
    const focus = clean.match(/次の重点は[、,]?\s*(.+)/);
    if (focus) {
      const core = focus[1].replace(/である$/, '').trim();
      return cap(`Prioritize: ${core}`);
    }
    return cap(`Prioritize: ${clean}`);
  }

  if (semanticClass === '[Execution]') {
    // Keep technical pipeline/phase notation intact, just prepend the verb
    return cap(`Proceed in phases: ${clean}`);
  }

  // [Direction] — default class
  // "X を厳守し..." → extract X as the maintained constraint
  const strictSubject = clean.match(/^(.+?)を厳守/);
  if (strictSubject) {
    return cap(`Maintain: ${strictSubject[1].trim()}`);
  }
  return cap(`Maintain: ${clean}`);
}

/**
 * Derives strategic_next_actions deterministically:
 *
 *   1. Committed decision memories — queried directly from DB, not from assembled.
 *      Decisions are strategic by definition; pattern matching over content is fragile
 *      and misses real signals ("A→B", "次の重点", "世界標準候補", etc.).
 *      Each decision is:
 *        a) classified into Goal / Priority / Execution / Direction
 *        b) transformed into a forward-looking action via transformDecisionToAction()
 *           — never copied verbatim
 *
 *   2. Active project content with roadmap signals (v1, A→B, 段階, milestone).
 *      Secondary source; skips items already covered by decision-derived actions.
 *
 *   3. Explicit goal-type memories (distinct memory_type; high signal).
 *
 * Strategic = where the project is heading. Operational = what to click next.
 * Do not surface pending proposals here.
 */
async function deriveStrategicNextActions(
  db: Pool,
  projectId: string | null,
  assembled: AssembledContext
): Promise<string[]> {
  const actions: string[] = [];

  // Classifier patterns — evaluated in priority order: Goal > Priority > Execution > Direction
  const goalClass      = /goal|目指|目標|世界標準|製品|product/i;
  const priorityClass  = /次の重点|重点|priority|focus|次に|完成度/i;
  const executionClass = /A→B|段階|phased|execution path|進める|ステップ|継続性/i;

  function classify(text: string): string {
    if (goalClass.test(text))      return '[Goal]';
    if (priorityClass.test(text))  return '[Priority]';
    if (executionClass.test(text)) return '[Execution]';
    return '[Direction]';
  }

  // 1. ALL committed decision memories are strategic — query directly from DB.
  if (projectId) {
    const { rows: decisionRows } = await db.query<{ content: string; summary: string | null }>(
      `SELECT content, summary FROM memories
       WHERE project_id = $1 AND status = 'active' AND memory_type = 'decision'
         AND trust_level = ANY(ARRAY['t3_committed', 't4_human', 't5_canonical'])
       ORDER BY importance_score DESC NULLS LAST
       LIMIT 5`,
      [projectId]
    );
    for (const r of decisionRows) {
      const text = r.summary ?? r.content;
      const semanticClass = classify(text);
      actions.push(transformDecisionToAction(text, semanticClass));
    }
  }

  // 2. Roadmap signals from active_project assembled content (secondary source).
  const projectCandidates = assembled.sections['active_project']?.content ?? [];
  const roadmapPattern = /v1|A→B|段階|phased|次のステップ|next step|roadmap|milestone/i;
  for (const item of projectCandidates) {
    if (roadmapPattern.test(item)) {
      const preview = item.length > 100 ? item.substring(0, 97) + '...' : item;
      const alreadyCovered = actions.some(a => a.includes(preview.substring(0, 40)));
      if (!alreadyCovered) actions.push(`Proceed in phases: ${preview}`);
    }
  }

  // 3. Explicit goal-type memories (rare; high signal).
  if (projectId) {
    const { rows: goalRows } = await db.query<{ content: string; summary: string | null }>(
      `SELECT content, summary FROM memories
       WHERE project_id = $1 AND status = 'active' AND memory_type = 'goal'
         AND trust_level = ANY(ARRAY['t3_committed', 't4_human', 't5_canonical'])
       ORDER BY importance_score DESC NULLS LAST LIMIT 2`,
      [projectId]
    );
    for (const r of goalRows) {
      const text = r.summary ?? r.content;
      const alreadyCovered = actions.some(a => a.includes(text.substring(0, 40)));
      if (!alreadyCovered) {
        actions.push(transformDecisionToAction(text, '[Goal]'));
      }
    }
  }

  return actions.slice(0, 5);
}

/**
 * Derives operational_next_actions deterministically:
 *   1. Pending proposals awaiting human approval
 *   2. Recent episodes with unresolved "next" or "todo" signals
 *
 * Operational = immediate tasks the next session must act on.
 */
async function deriveOperationalNextActions(
  db: Pool,
  projectId: string | null,
  assembled: AssembledContext
): Promise<string[]> {
  const actions: string[] = [];

  // 1. Pending proposals awaiting human approval
  const pendingQuery = projectId
    ? `SELECT mp.proposal_id, mp.memory_type, mp.proposed_content
       FROM memory_proposals mp
       LEFT JOIN sessions s ON s.session_id = mp.session_id
       WHERE mp.status = 'pending'
         AND (s.project_id = $1 OR mp.session_id IS NULL)
       ORDER BY mp.created_at DESC LIMIT 5`
    : `SELECT proposal_id, memory_type, proposed_content
       FROM memory_proposals WHERE status = 'pending'
       ORDER BY created_at DESC LIMIT 5`;

  const { rows: pending } = await db.query(pendingQuery, projectId ? [projectId] : []);
  for (const p of pending) {
    const preview = String(p.proposed_content).substring(0, 80);
    actions.push(`Approve pending ${p.memory_type} proposal (${p.proposal_id}): ${preview}`);
  }

  // 2. Recent episodes with todo/unresolved signals
  const episodeCandidates = assembled.sections['recent_episodes']?.content ?? [];
  const todoPattern = /todo|次のステップ|next step|未完|wip|in progress/i;
  for (const item of episodeCandidates) {
    if (todoPattern.test(item)) {
      const preview = item.length > 120 ? item.substring(0, 117) + '...' : item;
      if (!actions.includes(preview)) actions.push(preview);
    }
  }

  // Always add rebuild reminder if project has memories
  if (projectId) {
    actions.push('Run worker rebuild-context-cache to refresh handoff artifacts after new commits');
  }

  return actions.slice(0, 6);
}

/**
 * Derives open_loops deterministically:
 *   1. Decisions or project_state with deferred/pending signals
 *   2. Pending proposal count summary
 */
async function deriveOpenLoops(
  db: Pool,
  projectId: string | null,
  assembled: AssembledContext
): Promise<string[]> {
  const loops: string[] = [];

  const candidates = [
    ...(assembled.sections['relevant_decisions']?.content ?? []),
    ...(assembled.sections['active_project']?.content ?? []),
  ];
  const deferPattern = /v1以降|deferred|後で|later|postponed|まだ|not yet|認証|auth.*v1|todo/i;
  for (const item of candidates) {
    if (deferPattern.test(item)) {
      const preview = item.length > 120 ? item.substring(0, 117) + '...' : item;
      if (!loops.includes(preview)) loops.push(preview);
    }
  }

  const { rows: [countRow] } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM memory_proposals WHERE status = 'pending'`
  );
  const pendingCount = parseInt(countRow.count, 10);
  if (pendingCount > 0) {
    loops.push(`${pendingCount} proposal(s) pending human approval — run worker approve-proposal`);
  }

  return loops.slice(0, 5);
}

// --- Main generator ---

export async function generateHandoffContext(
  db: Pool,
  request: HandoffRequest
): Promise<HandoffContext> {
  const resolution = resolveIntent(request);
  const targetTokens = request.token_budget ?? 2000;
  const scope = planScope(resolution.intent, targetTokens);

  const assembled = await assembleContext(db, scope, {
    project_id: resolution.project_id,
    trust_min: 't2_validated',
  });

  // Project fallback: restricted to project_state / decision / episode — no identity/policy bleed
  if ((assembled.sections['active_project']?.content ?? []).length === 0) {
    const fallback = await deriveProjectFallback(db, resolution.project_id);
    if (fallback.length > 0) {
      assembled.sections['active_project'] = {
        content: fallback,
        memory_ids: [],
        tokens_used: fallback.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      };
      assembled.total_tokens += assembled.sections['active_project'].tokens_used;
    }
  }

  // Decisions fallback: runs outside assembler to bypass cross-section deduplication
  if ((assembled.sections['relevant_decisions']?.content ?? []).length === 0) {
    const fallback = await deriveDecisionsFallback(db, resolution.project_id);
    if (fallback.length > 0) {
      assembled.sections['relevant_decisions'] = {
        content: fallback,
        memory_ids: [],
        tokens_used: fallback.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      };
      assembled.total_tokens += assembled.sections['relevant_decisions'].tokens_used;
    }
  }

  // Synthesize action and loop sections
  const strategicActions = await deriveStrategicNextActions(db, resolution.project_id, assembled);
  const operationalActions = await deriveOperationalNextActions(db, resolution.project_id, assembled);
  const openLoops = await deriveOpenLoops(db, resolution.project_id, assembled);

  const synthesizedTokens =
    strategicActions.reduce((s, t) => s + Math.ceil(t.length / 4), 0) +
    operationalActions.reduce((s, t) => s + Math.ceil(t.length / 4), 0) +
    openLoops.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
  assembled.total_tokens += synthesizedTokens;

  const compressionLevel = determineCompressionLevel(assembled.total_tokens, targetTokens);

  const getSection = (key: string): string[] => {
    const sec = assembled.sections[key];
    if (!sec || sec.content.length === 0) return [];
    return compressContent(sec.content, scope.sections[key]?.token_budget ?? 200, compressionLevel);
  };

  const taskFrameArr = getSection('task_frame');
  const taskFrame = taskFrameArr.length > 0 ? taskFrameArr[0] : null;

  return {
    context_id: `ctx_${randomUUID().replace(/-/g, '').substring(0, 12)}`,
    intent: resolution.intent,
    role: resolution.role,
    project_id: resolution.project_id,
    generated_at: new Date().toISOString(),
    sections: {
      identity:     getSection('identity'),
      relationship: getSection('relationship'),
      global_policies:    getSection('global_policies'),
      active_project:     getSection('active_project'),
      relevant_decisions: getSection('relevant_decisions'),
      procedures:         getSection('procedures'),
      recent_episodes:    getSection('recent_episodes'),
      evidence:           getSection('evidence'),
      task_frame:         taskFrame,
      strategic_next_actions: compressContent(
        strategicActions,
        scope.sections['strategic_next_actions']?.token_budget ?? 150,
        compressionLevel
      ),
      operational_next_actions: compressContent(
        operationalActions,
        scope.sections['operational_next_actions']?.token_budget ?? 150,
        compressionLevel
      ),
      open_loops: compressContent(
        openLoops,
        scope.sections['open_loops']?.token_budget ?? 150,
        compressionLevel
      ),
    },
    token_budget: {
      target: targetTokens,
      used: assembled.total_tokens,
      compression_level: compressionLevel,
    },
    source_memories: assembled.source_memories,
  };
}
