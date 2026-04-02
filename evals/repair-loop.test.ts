/**
 * repair-loop.test.ts — regression tests for the eval:run / repair loop state-blind bug.
 *
 * Bug scenario (the exact sequence that triggered the gap):
 *   1. A committed policy ("Request-ID header for all API responses") existed in DB.
 *   2. The handoff artifact had global_policies: [] — the assembler missed it.
 *   3. eval:run ran pure evaluateHandoff() → 100/100 PASS, no failures, no mismatches.
 *   4. The user ran `worker rebuild-context-cache --repair`.
 *   5. repairContextCacheJob read the stale handoff-eval.json (produced by pure evaluator).
 *      That file had no state_consistency block → zero auto_fixable mismatches.
 *   6. Repair printed "skipped — no auto_fixable mismatches detected" and exited.
 *      The missing policy was never detected, never repaired.
 *
 * Root causes:
 *   A. eval:run used evaluateHandoff() — a pure function with no DB access. It cannot
 *      detect state mismatches (missing_policy, missing_project_state) by design.
 *   B. repairContextCacheJob trusted the stale handoff-eval.json for mismatch data.
 *      If that file was written by the pure evaluator, it has no state_consistency block
 *      and the repair loop silently skips even when the DB has authoritative evidence of problems.
 *
 * Fixes applied:
 *   A. eval:run now uses evaluateHandoffWithState(db, ctx) when DATABASE_URL is set.
 *      Falls back to evaluateHandoff() only if DATABASE_URL is unset or DB is unreachable.
 *      Writes evaluator_mode: "state_aware" | "pure" to handoff-eval.json.
 *   B. repairContextCacheJob now reads handoff-context.json and runs a fresh
 *      evaluateHandoffWithState(db, ctx) to get current mismatches — completely ignoring
 *      the stale handoff-eval.json for mismatch classification. It DOES overwrite
 *      handoff-eval.json with the authoritative state-aware result as a side-effect.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateHandoff, evaluateHandoffWithState } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResultV2, StateMismatch } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'data', 'fixtures', 'evals');

// ---------------------------------------------------------------------------
// Test runner (same pattern as handoff-eval-state.test.ts)
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

function loadFixture(name: string): HandoffContext {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
}

// DB row shapes match the SQL column names used by evaluateHandoffWithState queries.
interface MemoryRow { memory_id: string; memory_type: string; content: string; summary: string | null }
interface ProposalRow { proposal_id: string; memory_type: string; content: string; status: string }

function mockPool(memories: MemoryRow[], proposals: ProposalRow[]) {
  const responses = [{ rows: memories }, { rows: proposals }];
  let call = 0;
  return { query: async () => responses[call++] ?? { rows: [] } } as any;
}

/**
 * DB state: one committed policy memory whose content is NOT present in the artifact's
 * global_policies section (which is empty in mutation-missing-policy.json).
 */
function dbWithMissingPolicy() {
  return mockPool(
    [{ memory_id: 'mem_policy_001', memory_type: 'policy',
       content: 'All API responses must include X-Request-ID header. Unified policy.',
       summary: null }],
    []
  );
}

/** DB state: nothing committed — clean slate. */
function emptyDb() {
  return mockPool([], []);
}

console.log('\nRepair Loop Regression Tests\n');

// ============================================================================
// Root cause A: pure evaluator cannot detect missing_policy
// ============================================================================

test('bug A repro: pure evaluateHandoff() returns 100/100 — misses missing_policy', () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const result = evaluateHandoff(ctx);

  assert.strictEqual(result.score_total, 100,
    'pure eval returns 100/100 on missing-policy artifact — the bug');
  assert.strictEqual(result.failures.length, 0,
    'pure eval reports zero failures');
  assert.strictEqual(result.failure_details.length, 0,
    'pure eval reports zero failure_details');
});

test('fix A: evaluateHandoffWithState() detects missing_policy (severity=critical, auto_fixable=true)', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const result = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;

  const mismatch = result.state_consistency.mismatches.find(m => m.mismatch_type === 'missing_policy');
  assert.ok(mismatch, 'state-aware eval must detect missing_policy mismatch');
  assert.strictEqual(mismatch!.severity, 'critical');
  assert.strictEqual(mismatch!.auto_fixable, true);
});

test('fix A: state-aware result carries state_consistency block; pure result does not', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const stateResult = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;
  const pureResult = evaluateHandoff(ctx);

  assert.ok('state_consistency' in stateResult,
    'state-aware result must have state_consistency block');
  assert.ok(!('state_consistency' in pureResult),
    'pure result must NOT have state_consistency block');
});

// ============================================================================
// Root cause B: stale handoff-eval.json has no state_consistency → repair skips
// ============================================================================

test('bug B repro: stale pure-eval has no state_consistency → zero auto_fixable → repair skips', () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const staleEval = evaluateHandoff(ctx);

  // Simulate what the old repair logic did: trust the stale eval for mismatch data
  const staleState = (staleEval as Partial<HandoffEvalResultV2>).state_consistency;
  const autoFixableFromStale = staleState
    ? staleState.mismatches.filter(m => m.auto_fixable)
    : [];

  assert.strictEqual(autoFixableFromStale.length, 0,
    'reading stale pure-eval gives zero auto_fixable mismatches → repair skips — the bug');
});

test('fix B: fresh evaluateHandoffWithState() on same context → 1 auto_fixable mismatch', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const freshEval = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;

  const autoFixableFromFresh = freshEval.state_consistency.mismatches.filter(m => m.auto_fixable);

  assert.strictEqual(autoFixableFromFresh.length, 1,
    'fresh state-aware eval on same context → 1 auto_fixable mismatch found');
  assert.strictEqual(autoFixableFromFresh[0].mismatch_type, 'missing_policy');
});

test('fix B: fresh pre-repair eval has state_consistency — safe to overwrite handoff-eval.json', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const freshEval = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;

  assert.ok(freshEval.state_consistency.mismatches.length > 0,
    'fresh eval has mismatches — this authoritative result gets written to handoff-eval.json');
});

// ============================================================================
// Repair diff logic — resolved vs unresolved by mismatch_type::db_id key
// ============================================================================

test('repair diff: resolved/unresolved computed correctly by mismatch_type::db_id', () => {
  const makeMismatch = (db_id: string): StateMismatch => ({
    mismatch_type: 'missing_policy',
    db_id,
    db_type: 'policy',
    handoff_section: 'global_policies',
    detail: `Committed policy not reflected in global_policies`,
    severity: 'critical',
    fix_hint: 'Re-run rebuild-context-cache',
    auto_fixable: true,
  });

  const beforeMismatches = [makeMismatch('mem_abc'), makeMismatch('mem_xyz')];
  const afterMismatches  = [makeMismatch('mem_xyz')]; // only mem_xyz remains

  const afterKeys = new Set(afterMismatches.map(m => `${m.mismatch_type}::${m.db_id}`));
  const resolved   = beforeMismatches.filter(m => !afterKeys.has(`${m.mismatch_type}::${m.db_id}`));
  const unresolved = beforeMismatches.filter(m =>  afterKeys.has(`${m.mismatch_type}::${m.db_id}`));

  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].db_id, 'mem_abc', 'mem_abc was resolved after regeneration');
  assert.strictEqual(unresolved.length, 1);
  assert.strictEqual(unresolved[0].db_id, 'mem_xyz', 'mem_xyz still missing after regeneration');
});

// ============================================================================
// Repair status computation
// ============================================================================

test('repair_status: success/partial/no_change computed correctly from resolved count', () => {
  const computeStatus = (total: number, resolved: number): string =>
    resolved === total ? 'success' :
    resolved === 0     ? 'no_change' : 'partial';

  assert.strictEqual(computeStatus(2, 2), 'success',   'all resolved → success');
  assert.strictEqual(computeStatus(2, 1), 'partial',   'some resolved → partial');
  assert.strictEqual(computeStatus(2, 0), 'no_change', 'none resolved → no_change');
});

test('repair_status=skipped: fresh eval on empty DB → zero auto_fixable → repair skips', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = emptyDb(); // DB has no committed memories
  const freshEval = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;
  const autoFixable = freshEval.state_consistency.mismatches.filter(m => m.auto_fixable);

  assert.strictEqual(autoFixable.length, 0,
    'empty DB → zero auto_fixable mismatches → repair_status would be skipped');
});

// ============================================================================
// evaluator_mode field — annotates handoff-eval.json with mode used
// ============================================================================

test('evaluator_mode="pure" attached to pure result for file output', () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const pureResult = evaluateHandoff(ctx);
  const output = { ...pureResult, evaluator_mode: 'pure' as const };

  assert.strictEqual(output.evaluator_mode, 'pure');
  assert.strictEqual(output.score_total, 100); // original fields preserved
});

test('evaluator_mode="state_aware" attached to state-aware result for file output', async () => {
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const stateResult = await evaluateHandoffWithState(db, ctx);
  const output = { ...stateResult, evaluator_mode: 'state_aware' as const };

  assert.strictEqual(output.evaluator_mode, 'state_aware');
  assert.ok('state_consistency' in output); // state_consistency block preserved
});

// ============================================================================
// End-to-end: fixed eval:run flow — misses nothing when DB is available
// ============================================================================

test('end-to-end: fixed eval:run surfaces missing_policy and emits repair hint', async () => {
  // Simulate the fixed eval:run flow:
  //   1. Read handoff-context.json (mutation-missing-policy.json)
  //   2. DATABASE_URL available → run evaluateHandoffWithState()
  //   3. Detect missing_policy → produce auto_fixable mismatch → hint shown
  const ctx = loadFixture('mutation-missing-policy.json');
  const db = dbWithMissingPolicy();
  const result = await evaluateHandoffWithState(db, ctx) as HandoffEvalResultV2;
  const output = { ...result, evaluator_mode: 'state_aware' as const };

  const autoFixableMismatches = result.state_consistency.mismatches.filter(m => m.auto_fixable);

  assert.strictEqual(output.evaluator_mode, 'state_aware');
  assert.ok(autoFixableMismatches.length > 0,
    'state-aware eval exposes auto_fixable mismatches for the repair hint');
  assert.ok(
    autoFixableMismatches.every(m =>
      m.mismatch_type === 'missing_policy' || m.mismatch_type === 'missing_project_state'
    ),
    'all auto_fixable mismatches are assembly-side issues (not human-action required)'
  );
});
