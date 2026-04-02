/**
 * State-aware handoff evaluator tests (v0.5).
 *
 * Tests evaluateHandoffWithState() using mock DB pools — no real database required.
 * Each test provides predefined query responses and verifies the state_consistency
 * block of the returned HandoffEvalResultV2.
 *
 * Mismatch types under test:
 *   missing_policy        — committed policy not in global_policies section
 *   missing_project_state — committed project_state not in active_project section
 *   unresolved_proposal   — pending proposal not surfaced in operational or open_loops
 *   stale_loop            — open_loop resolved by committed settled state: policy, project_state, procedure, or non-deferred decision
 *   strategic_contradiction — Pursue: action vs committed deferred decision (DB)
 *
 * v0.5 additions under test:
 *   ≥2 token threshold    — single-token overlap is no longer sufficient for coverage
 *   short-fingerprint fallback — 1-token fingerprints still match on 1 shared token
 *   n-gram extraction     — bigrams appear in fingerprints (e.g., "rate_limiting")
 *   richer DEFER_SIGNAL   — "out of scope" and "backlog" recognized as deferral
 *
 * The "count_match_topic_miss" test demonstrates why count-based checks are insufficient:
 *   old approach — 1 pending proposal + 1 open_loop with "pending" keyword → count match → no alert
 *   v0.4 approach — topic fingerprints don't overlap → unresolved_proposal fires
 */

import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateHandoff, evaluateHandoffWithState } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResultV2, StateMismatch } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'data', 'fixtures', 'evals');

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function test(name: string, fn: () => Promise<void> | void) {
  (async () => {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      process.exitCode = 1;
    }
  })();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal valid HandoffContext with only the specified sections overridden.
 * All other sections default to empty arrays / null.
 */
function makeCtx(sections: Partial<HandoffContext['sections']>): HandoffContext {
  return {
    context_id:   'ctx_state_test',
    intent:       'handoff',
    role:         'assistant',
    project_id:   'proj_test',
    generated_at: new Date().toISOString(),
    sections: {
      identity:                 [],
      relationship:             [],
      global_policies:          [],
      active_project:           [],
      relevant_decisions:       [],
      procedures:               [],
      recent_episodes:          [],
      evidence:                 [],
      task_frame:               null,
      strategic_next_actions:   [],
      operational_next_actions: [],
      open_loops:               [],
      ...sections,
    },
    token_budget:   { target: 2000, used: 100, compression_level: 'none' },
    source_memories: [{ memory_id: 'mem_seed', score: 0.9, trust_level: 't3_committed' }],
  };
}

/** Row shape returned by the committed-memories query (Query 1). */
interface MemoryRow {
  memory_id: string;
  memory_type: string;
  content: string;
  summary: string | null;
}

/** Row shape returned by the pending-proposals query (Query 2). */
interface ProposalRow {
  proposal_id: string;
  memory_type: string;
  content: string;   // alias of proposed_content
  status: string;
}

/**
 * Creates a minimal Pool-compatible mock that returns predefined rows for the
 * two sequential queries evaluateHandoffWithState() makes:
 *   call 0 → committed memories (Query 1)
 *   call 1 → pending proposals (Query 2)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPool(memories: MemoryRow[], proposals: ProposalRow[]): any {
  const responses = [{ rows: memories }, { rows: proposals }];
  let call = 0;
  return { query: async () => responses[call++] ?? { rows: [] } };
}

function getMismatches(result: HandoffEvalResultV2): StateMismatch[] {
  return result.state_consistency.mismatches;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nHandoff Eval State Tests (v0.5)\n');

// --- Structure ---

test('result has state_consistency with required top-level keys', async () => {
  const pool = mockPool([], []);
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const sc = result.state_consistency;
  assert.ok(Array.isArray(sc.proposal_topics_db), 'proposal_topics_db should be array');
  assert.ok(Array.isArray(sc.memory_topics_db), 'memory_topics_db should be array');
  assert.ok(Array.isArray(sc.mismatches), 'mismatches should be array');
  assert.ok(typeof sc.handoff_topics === 'object', 'handoff_topics should be object');
  assert.ok(Array.isArray(sc.handoff_topics.global_policies), 'handoff_topics.global_policies');
  assert.ok(Array.isArray(sc.handoff_topics.active_project), 'handoff_topics.active_project');
  assert.ok(Array.isArray(sc.handoff_topics.relevant_decisions), 'handoff_topics.relevant_decisions');
  assert.ok(Array.isArray(sc.handoff_topics.open_loops), 'handoff_topics.open_loops');
  assert.ok(Array.isArray(sc.handoff_topics.operational_next_actions), 'handoff_topics.operational_next_actions');
});

test('base HandoffEvalResult fields are preserved in HandoffEvalResultV2', async () => {
  const pool = mockPool([], []);
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  assert.ok(result.eval_id.startsWith('eval_'));
  assert.strictEqual(result.context_id, 'ctx_state_test');
  assert.strictEqual(result.score_max, 100);
  assert.ok(Array.isArray(result.categories) && result.categories.length === 8);
});

// --- Clean state: no mismatches ---

test('clean state: committed policy topic covered in global_policies → no missing_policy', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_p1', memory_type: 'policy', content: 'X-Request-ID required for all API responses', summary: null }],
    []
  );
  const ctx = makeCtx({
    global_policies: ['All API responses must include X-Request-ID header. Unified policy.'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  const mismatches = getMismatches(result);
  assert.ok(
    !mismatches.some(m => m.mismatch_type === 'missing_policy'),
    `Expected no missing_policy when topics overlap. Got: ${JSON.stringify(mismatches)}`
  );
});

test('clean state: empty DB produces zero mismatches', async () => {
  const pool = mockPool([], []);
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  assert.strictEqual(getMismatches(result).length, 0);
});

// --- missing_policy ---

test('missing_policy: committed policy not in global_policies fires mismatch', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_p1', memory_type: 'policy', content: 'All requests must include authentication token', summary: null }],
    []
  );
  const ctx = makeCtx({
    global_policies: [], // empty — policy not surfaced
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  const mismatches = getMismatches(result);
  assert.ok(
    mismatches.some(m => m.mismatch_type === 'missing_policy'),
    `Expected missing_policy mismatch. Got: ${JSON.stringify(mismatches)}`
  );
});

test('missing_policy: mismatch references correct db_id and handoff_section', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_policy_abc', memory_type: 'policy', content: 'Rate limiting: 100 requests per minute per client', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({ global_policies: [] }));
  const m = getMismatches(result).find(m => m.mismatch_type === 'missing_policy');
  assert.ok(m, 'Expected missing_policy mismatch');
  assert.strictEqual(m!.db_id, 'mem_policy_abc');
  assert.strictEqual(m!.handoff_section, 'global_policies');
});

// --- missing_project_state ---

test('missing_project_state: committed project_state not in active_project fires mismatch', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_ps1', memory_type: 'project_state', content: 'Authentication module refactoring in progress since March 2026', summary: null }],
    []
  );
  const ctx = makeCtx({
    active_project: ['Memory OS pipeline complete. Core ingest working.'],
    // "authentication" not mentioned — topic gap
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'missing_project_state'),
    'Expected missing_project_state mismatch'
  );
});

test('missing_project_state: no mismatch when topic is covered', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_ps1', memory_type: 'project_state', content: 'Authentication module refactoring in progress', summary: null }],
    []
  );
  const ctx = makeCtx({
    active_project: ['Authentication module refactoring underway. Pipeline stable.'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'missing_project_state'),
    'Expected no missing_project_state when topic overlaps'
  );
});

// --- unresolved_proposal ---

test('unresolved_proposal: pending proposal not in operational or open_loops fires mismatch', async () => {
  const pool = mockPool(
    [],
    [{ proposal_id: 'prop_x1', memory_type: 'identity', content: 'User profile: principal engineer specializing in distributed systems', status: 'pending' }]
  );
  const ctx = makeCtx({
    operational_next_actions: ['Run rebuild-context-cache after next commit'],
    // "principal", "engineer", "distributed", "systems" not mentioned
    open_loops: [],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'unresolved_proposal'),
    'Expected unresolved_proposal mismatch'
  );
});

test('unresolved_proposal: proposal topic in operational_next_actions → no mismatch', async () => {
  const pool = mockPool(
    [],
    [{ proposal_id: 'prop_x2', memory_type: 'identity', content: 'User profile: principal engineer specializing in distributed systems', status: 'pending' }]
  );
  const ctx = makeCtx({
    operational_next_actions: ['Approve pending identity proposal: principal engineer at distributed systems team'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'unresolved_proposal'),
    'Expected no unresolved_proposal when topic appears in operational'
  );
});

test('unresolved_proposal: proposal topic in open_loops → no mismatch', async () => {
  const pool = mockPool(
    [],
    [{ proposal_id: 'prop_x3', memory_type: 'policy', content: 'Rate limiting enforcement pending final review', status: 'approved' }]
  );
  const ctx = makeCtx({
    open_loops: ['Rate limiting policy pending final approval decision'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'unresolved_proposal'),
    'Expected no unresolved_proposal when topic appears in open_loops'
  );
});

// --- stale_loop (DB-authoritative) ---

test('stale_loop: open_loop topic resolved by committed non-deferred decision fires mismatch', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d1', memory_type: 'decision', content: 'TypeScript strict mode enabled for all packages as of March 2026', summary: null }],
    // No DEFER_SIGNAL in content → deferred=false → stale_loop check applies
    []
  );
  const ctx = makeCtx({
    open_loops: ['TypeScript strict mode not yet applied to all packages'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'stale_loop'),
    'Expected stale_loop mismatch'
  );
});

test('stale_loop: deferred decision does NOT trigger stale_loop', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d2', memory_type: 'decision', content: 'TypeScript strict mode deferred — will apply in v1', summary: null }],
    []
  );
  const ctx = makeCtx({
    open_loops: ['TypeScript strict mode not yet applied'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'stale_loop'),
    'Deferred decision should not trigger stale_loop — loop is legitimately open'
  );
});

// --- strategic_contradiction (DB-authoritative) ---

test('strategic_contradiction: Pursue: action contradicts committed deferred decision', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d3', memory_type: 'decision', content: 'Authentication system deferred to v1+. Not in v0 scope.', summary: null }],
    []
  );
  const ctx = makeCtx({
    strategic_next_actions: ['Pursue: authentication system implementation for v0 users'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'strategic_contradiction'),
    'Expected strategic_contradiction mismatch'
  );
});

test('strategic_contradiction: non-Pursue: actions do not trigger contradiction', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d4', memory_type: 'decision', content: 'Authentication system deferred to v1+.', summary: null }],
    []
  );
  const ctx = makeCtx({
    // "Maintain:" not "Pursue:" — should not trigger
    strategic_next_actions: ['Maintain: current pipeline without authentication until v1'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'strategic_contradiction'),
    'Non-Pursue: actions should not trigger strategic_contradiction'
  );
});

// --- count_match_topic_miss (demonstrates improvement over count-based approach) ---

/**
 * Scenario:
 *   - DB: 1 pending proposal about "authentication required for all API endpoints"
 *   - Handoff open_loops: 1 item that contains "pending" (matches old PROPOSAL_REF regex)
 *     but is about TypeScript strict mode — wrong topic
 *
 * Old count-based approach would see: pending_count=1, open_loop_proposal_count=1 → match → no issue
 * v0.4 topic approach: proposal fingerprint {"authentication","required","endpoints"}
 *                      open_loops fingerprint {"typescript","strict","mode","applied",...}
 *                      No overlap → unresolved_proposal fires
 */
test('count_match_topic_miss: count matches but topic mismatch still fires unresolved_proposal', async () => {
  const pool = mockPool(
    [],
    [{ proposal_id: 'prop_auth', memory_type: 'policy', content: 'authentication required for all API endpoints', status: 'pending' }]
  );
  const ctx = makeCtx({
    // 1 item in open_loops that contains "pending" — old count check would not flag this
    // (open_loops_proposal_count=1 == db_pending_count=1)
    // But the topic is TypeScript, not authentication → v0.4 flags it
    open_loops: ['TypeScript strict mode not yet applied — pending engineering decision'],
    operational_next_actions: [],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'unresolved_proposal'),
    'Expected unresolved_proposal despite open_loop "pending" keyword match — topic mismatch not count mismatch'
  );
});

// --- TopicRecord shape ---

test('memory_topics_db entries have correct shape', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_shape', memory_type: 'policy', content: 'Write path is proposal approval commit cycle', summary: 'strict write path' }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const rec = result.state_consistency.memory_topics_db[0];
  assert.ok(rec, 'Expected at least one memory_topics_db entry');
  assert.strictEqual(rec.id, 'mem_shape');
  assert.strictEqual(rec.type, 'policy');
  assert.ok(Array.isArray(rec.fingerprint), 'fingerprint should be array');
  assert.ok(typeof rec.content_preview === 'string', 'content_preview should be string');
});

test('decision memory TopicRecord has deferred flag', async () => {
  const pool = mockPool(
    [
      { memory_id: 'mem_deferred', memory_type: 'decision', content: 'Authentication deferred to v1+', summary: null },
      { memory_id: 'mem_active',   memory_type: 'decision', content: 'Monorepo structure finalized with pnpm workspaces', summary: null },
    ],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const deferred = result.state_consistency.memory_topics_db.find(r => r.id === 'mem_deferred');
  const active   = result.state_consistency.memory_topics_db.find(r => r.id === 'mem_active');
  assert.ok(deferred, 'Expected deferred decision record');
  assert.ok(active, 'Expected active decision record');
  assert.strictEqual(deferred!.deferred, true, 'Deferred decision should have deferred=true');
  assert.strictEqual(active!.deferred, false, 'Non-deferred decision should have deferred=false');
});

// --- Multiple mismatches ---

test('multiple mismatches detected in a single call', async () => {
  const pool = mockPool(
    [
      { memory_id: 'mem_p1', memory_type: 'policy',       content: 'Rate limiting: 100 rpm per client', summary: null },
      { memory_id: 'mem_ps1', memory_type: 'project_state', content: 'Database migration to Postgres 16 in progress', summary: null },
    ],
    [
      { proposal_id: 'prop_y', memory_type: 'identity', content: 'User role: senior backend engineer', status: 'pending' },
    ]
  );
  const ctx = makeCtx({
    global_policies:          [], // missing rate-limiting policy
    active_project:           ['MCP server wiring underway'], // missing migration topic
    operational_next_actions: [], // proposal not surfaced
    open_loops:               [],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  const mismatches = getMismatches(result);
  assert.ok(mismatches.some(m => m.mismatch_type === 'missing_policy'),        'Expected missing_policy');
  assert.ok(mismatches.some(m => m.mismatch_type === 'missing_project_state'), 'Expected missing_project_state');
  assert.ok(mismatches.some(m => m.mismatch_type === 'unresolved_proposal'),   'Expected unresolved_proposal');
});

// ---------------------------------------------------------------------------
// v0.5: ≥2 token threshold for fingerprintOverlap
// ---------------------------------------------------------------------------

/**
 * Demonstrates why ≥2 tokens is required: a policy about "rate limiting" shares
 * only the token "client" with a section about "client authentication". Under the
 * old 1-token threshold this would suppress missing_policy (false negative).
 * Under v0.5, 1 shared token is insufficient (both fingerprints have ≥2 tokens)
 * → missing_policy fires correctly.
 */
test('≥2 token threshold: single-token overlap no longer suppresses missing_policy', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_rate', memory_type: 'policy', content: 'rate limiting enforced: 100 requests per client per minute', summary: null }],
    []
  );
  const ctx = makeCtx({
    // "client" appears but "rate" and "limiting" do not — only 1 shared token
    global_policies: ['Client authentication required for all endpoints. Tokens mandatory.'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    getMismatches(result).some(m => m.mismatch_type === 'missing_policy'),
    'Single-token overlap insufficient with ≥2 threshold — missing_policy should fire'
  );
});

/**
 * Short-fingerprint fallback: when either side has fewer than 2 tokens,
 * 1 shared token is accepted to avoid always-missing on tiny fingerprints.
 * A one-word policy ("CORS") has fingerprint length 1 → fallback applies.
 */
test('short-fingerprint fallback: 1-token policy still matches on 1 shared token', async () => {
  const pool = mockPool(
    // "cors" is the only token (4 chars, not stopword) — fingerprint length = 1
    [{ memory_id: 'mem_cors', memory_type: 'policy', content: 'cors enabled globally', summary: null }],
    []
  );
  const ctx = makeCtx({
    // "cors" appears here — 1 shared token; policy FP length=1 < minShared=2 → fallback
    global_policies: ['CORS enabled with allow-origin wildcard for internal APIs'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'missing_policy'),
    'Short-fingerprint fallback should allow 1-shared-token match for tiny fingerprints'
  );
});

// ---------------------------------------------------------------------------
// v0.5: n-gram (bigram) extraction in topicFingerprint
// ---------------------------------------------------------------------------

test('n-gram extraction: memory fingerprint contains bigrams for compound concepts', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_bigram', memory_type: 'policy', content: 'request rate limiting enforced globally', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const fp = result.state_consistency.memory_topics_db[0]?.fingerprint ?? [];
  assert.ok(fp.some(t => t.includes('_')),
    `Expected bigrams (tokens with "_") in fingerprint. Got: ${JSON.stringify(fp)}`
  );
  assert.ok(fp.includes('rate_limiting'),
    `Expected "rate_limiting" bigram in fingerprint. Got: ${JSON.stringify(fp)}`
  );
});

test('n-gram extraction: bigrams enable compound-concept overlap matching', async () => {
  // Policy about "request rate limiting" — bigram "rate_limiting" in both policy and section
  // This allows compound-concept matching even when individual words are insufficient
  const pool = mockPool(
    [{ memory_id: 'mem_rl', memory_type: 'policy', content: 'strict request rate limiting policy enforced', summary: null }],
    []
  );
  const ctx = makeCtx({
    // Different phrasing but "rate limiting" as a compound concept appears in both
    global_policies: ['Rate limiting: 100 requests per minute enforced per client endpoint'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'missing_policy'),
    'Bigram "rate_limiting" should allow compound-concept match → no missing_policy'
  );
});

// ---------------------------------------------------------------------------
// v0.5: richer DEFER_SIGNAL coverage
// ---------------------------------------------------------------------------

test('richer DEFER_SIGNAL: "out of scope" marks decision as deferred', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_oos', memory_type: 'decision', content: 'Multi-region deployment is out of scope for v0 release', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const rec = result.state_consistency.memory_topics_db.find(r => r.id === 'mem_oos');
  assert.ok(rec, 'Expected decision record in memory_topics_db');
  assert.strictEqual(rec!.deferred, true,
    'Expected deferred=true for "out of scope" decision'
  );
});

test('richer DEFER_SIGNAL: "backlog" marks decision as deferred', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_bl', memory_type: 'decision', content: 'SSO integration moved to backlog pending v1 planning', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({}));
  const rec = result.state_consistency.memory_topics_db.find(r => r.id === 'mem_bl');
  assert.ok(rec, 'Expected decision record in memory_topics_db');
  assert.strictEqual(rec!.deferred, true,
    'Expected deferred=true for "backlog" decision'
  );
});

test('richer DEFER_SIGNAL: "out of scope" deferred decision does NOT trigger stale_loop', async () => {
  // Even though a committed decision covers the same topic as an open loop,
  // if the decision is "out of scope" (deferred), the loop is legitimately open.
  const pool = mockPool(
    [{ memory_id: 'mem_sso', memory_type: 'decision', content: 'SSO integration out of scope for v0 — revisit in v1', summary: null }],
    []
  );
  const ctx = makeCtx({
    open_loops: ['SSO integration timeline not yet finalized'],
  });
  const result = await evaluateHandoffWithState(pool, ctx);
  assert.ok(
    !getMismatches(result).some(m => m.mismatch_type === 'stale_loop'),
    'Out-of-scope decision should not trigger stale_loop — loop is legitimately open'
  );
});

// ---------------------------------------------------------------------------
// v1.0: severity, fix_hint, auto_fixable on StateMismatch
// ---------------------------------------------------------------------------

test('v1.0: missing_policy mismatch has severity=critical, auto_fixable=true', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_p1', memory_type: 'policy', content: 'Rate limiting: 100 requests per minute per client', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({ global_policies: [] }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'missing_policy');
  assert.ok(m, 'Expected missing_policy mismatch');
  assert.strictEqual(m!.severity,     'critical', 'missing_policy should be critical');
  assert.strictEqual(m!.auto_fixable, true,       'missing_policy should be auto_fixable (re-run rebuild)');
  assert.ok(typeof m!.fix_hint === 'string' && m!.fix_hint.length > 20, 'fix_hint should be a non-trivial string');
});

test('v1.0: missing_project_state mismatch has severity=critical, auto_fixable=true', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_ps1', memory_type: 'project_state', content: 'Authentication module refactoring in progress', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({ active_project: [] }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'missing_project_state');
  assert.ok(m, 'Expected missing_project_state mismatch');
  assert.strictEqual(m!.severity,     'critical');
  assert.strictEqual(m!.auto_fixable, true, 'Committed data in DB — re-running rebuild suffices');
});

test('v1.0: unresolved_proposal mismatch has severity=warning, auto_fixable=false', async () => {
  const pool = mockPool(
    [],
    [{ proposal_id: 'prop_x1', memory_type: 'identity', content: 'User profile: principal engineer at distributed systems team', status: 'pending' }]
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({ operational_next_actions: [], open_loops: [] }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'unresolved_proposal');
  assert.ok(m, 'Expected unresolved_proposal mismatch');
  assert.strictEqual(m!.severity,     'warning', 'Pending proposals are warning, not critical');
  assert.strictEqual(m!.auto_fixable, false,     'Human approval required — not auto_fixable');
});

test('v1.0: stale_loop mismatch has severity=warning, auto_fixable=false', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d1', memory_type: 'decision', content: 'TypeScript strict mode enabled for all packages as of March 2026', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['TypeScript strict mode not yet applied to all packages'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'Expected stale_loop mismatch');
  assert.strictEqual(m!.severity,     'warning', 'Stale loops are warning, not critical');
  assert.strictEqual(m!.auto_fixable, false,     'Generator fix needed — not auto_fixable');
});

test('v1.0: strategic_contradiction mismatch has severity=critical, auto_fixable=false', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_d3', memory_type: 'decision', content: 'Authentication system deferred to v1+. Not in v0 scope.', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    strategic_next_actions: ['Pursue: authentication system implementation for v0 users'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'strategic_contradiction');
  assert.ok(m, 'Expected strategic_contradiction mismatch');
  assert.strictEqual(m!.severity,     'critical', 'Strategic contradiction actively harms next session');
  assert.strictEqual(m!.auto_fixable, false,      'Requires human judgment on direction change');
});

test('v1.0: fix_hint references the handoff_section it affects', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_p2', memory_type: 'policy', content: 'Strict rate limiting policy for all API endpoints', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({ global_policies: [] }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'missing_policy');
  assert.ok(m, 'Expected missing_policy mismatch');
  // fix_hint should mention rebuild-context-cache and global_policies or policy
  assert.ok(
    m!.fix_hint.includes('rebuild-context-cache') || m!.fix_hint.includes('policy'),
    `fix_hint should reference the remediation action. Got: "${m!.fix_hint}"`
  );
});

// ============================================================================
// stale_loop expanded set regression tests (v1.1)
//
// Bug: stale_loop only compared open_loops against committed decision memories.
// A committed POLICY covering the same topic as an open_loop was not detected.
// Fix: stale_loop now checks all settled committed state:
//   policy, project_state, procedure, and non-deferred decision.
// ============================================================================

test('stale_loop expanded: committed policy makes matching open_loop stale', async () => {
  // Bug repro: "Implement request_id in all API responses" is in open_loops,
  // but a committed policy already mandates it. With OLD logic: no detection.
  // With NEW logic: stale_loop fires because the policy covers the same topic.
  const pool = mockPool(
    [{ memory_id: 'mem_pol_rid', memory_type: 'policy',
       content: 'All API responses must include X-Request-ID header. Unified policy.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    global_policies: ['All API responses must include X-Request-ID header. Unified policy.'],
    open_loops: ['Implement request_id in all API responses'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'Committed policy + matching open_loop must fire stale_loop');
  assert.strictEqual(m!.db_type, 'policy', 'db_type must reflect the source memory type');
  assert.strictEqual(m!.severity, 'warning');
  assert.strictEqual(m!.auto_fixable, false);
});

test('stale_loop expanded: committed project_state makes matching open_loop stale', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_ps1', memory_type: 'project_state',
       content: 'Memory OS v0 handoff pipeline is complete. Phase 1 done.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['handoff pipeline completion for Memory OS v0 phase one'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'Committed project_state + matching open_loop must fire stale_loop');
  assert.strictEqual(m!.db_type, 'project_state');
});

test('stale_loop expanded: committed procedure makes matching open_loop stale', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_proc1', memory_type: 'procedure',
       content: 'Deployment procedure: run pnpm build, then docker build, then push to registry.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['deployment procedure: build and push docker image to registry'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'Committed procedure + matching open_loop must fire stale_loop');
  assert.strictEqual(m!.db_type, 'procedure');
});

test('stale_loop expanded: non-deferred decision still makes matching open_loop stale', async () => {
  // Regression: the decision-based stale_loop must still work after the refactor
  const pool = mockPool(
    [{ memory_id: 'mem_d9', memory_type: 'decision',
       content: 'TypeScript strict mode enabled for all packages. Decided 2026-04-01.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['TypeScript strict mode not yet applied to all packages'],
  }));
  const m = getMismatches(result).find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'Non-deferred decision stale_loop must still work after refactor');
  assert.strictEqual(m!.db_type, 'decision');
});

test('stale_loop expanded: deferred decision does NOT trigger stale_loop (strategic_contradiction handles it)', async () => {
  // Deferred decisions are handled by strategic_contradiction, not stale_loop.
  // Regression guard: expanding the type set must not accidentally include deferred decisions.
  const pool = mockPool(
    [{ memory_id: 'mem_d_auth', memory_type: 'decision',
       content: 'Authentication deferred to v1+. Out of scope for v0.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['Authentication not yet implemented — deferred to v1+'],
  }));
  const staleMismatches = getMismatches(result).filter(x => x.mismatch_type === 'stale_loop');
  assert.strictEqual(staleMismatches.length, 0,
    'Deferred decisions must NOT trigger stale_loop (only strategic_contradiction for Pursue: actions)');
});

test('stale_loop expanded: policy with no matching open_loop produces no stale_loop mismatch', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_pol2', memory_type: 'policy',
       content: 'Rate limiting policy: 100 requests per minute per client.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, makeCtx({
    open_loops: ['Authentication not yet implemented — deferred to v1+'],
  }));
  const staleMismatches = getMismatches(result).filter(x => x.mismatch_type === 'stale_loop');
  assert.strictEqual(staleMismatches.length, 0,
    'Policy with unrelated open_loop must not produce a false positive stale_loop');
});

test('stale_loop expanded: fixture mutation-stale-policy-loop.json — pure eval misses it (100/100)', () => {
  // The pure evaluator cannot see committed DB state, so a stale open_loop
  // whose topic is in global_policies (not relevant_decisions) is invisible to it.
  const ctx: HandoffContext = JSON.parse(
    readFileSync(resolve(FIXTURES, 'mutation-stale-policy-loop.json'), 'utf8')
  );
  const result = evaluateHandoff(ctx);
  assert.strictEqual(result.score_total, 100,
    'Pure eval returns 100/100 — stale policy loop is invisible without DB state');
  const stale = result.failures.some(f => f.includes('stale'));
  assert.ok(!stale, 'Pure eval must not report a stale loop (it cannot see the committed policy)');
});

test('stale_loop expanded: fixture mutation-stale-policy-loop.json — state-aware eval detects stale_loop', async () => {
  const ctx: HandoffContext = JSON.parse(
    readFileSync(resolve(FIXTURES, 'mutation-stale-policy-loop.json'), 'utf8')
  );
  const pool = mockPool(
    [{ memory_id: 'mem_rid_pol', memory_type: 'policy',
       content: 'All API responses must include X-Request-ID header. Unified policy.',
       summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, ctx) as HandoffEvalResultV2;
  const m = result.state_consistency.mismatches.find(x => x.mismatch_type === 'stale_loop');
  assert.ok(m, 'State-aware eval must detect stale_loop from committed policy vs open_loop');
  assert.strictEqual(m!.db_type, 'policy',
    'db_type must be "policy" — the settled state that makes the loop stale');
  assert.ok(m!.detail.includes('request') || m!.detail.includes('API') || m!.detail.includes('Implement'),
    `detail should reference the stale loop content. Got: "${m!.detail}"`);
});

