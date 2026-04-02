/**
 * Mutation-based robustness tests.
 *
 * Each fixture is a minimally mutated version of a valid handoff artifact.
 * The evaluator should detect the specific bug introduced by the mutation.
 * These tests confirm robustness: the evaluator catches real issues in
 * otherwise well-formed artifacts — not just obviously broken ones.
 *
 * Mutations under test:
 *
 *   mutation-stale-loop            — completed task left in open_loops after its
 *                                    decision was committed non-deferred → sub-check 3 fires
 *
 *   mutation-missing-policy        — committed policy silently dropped from global_policies
 *                                    → pure evaluator: no penalty (structural gap)
 *                                    → state-aware evaluator: missing_policy mismatch fires
 *
 *   mutation-design-first          — relationship declares "design-first" but all strategic
 *                                    actions are implementation-focused → sub-check 5 fires
 *
 *   mutation-contradicting-pursue  — "Pursue:" action contradicts a committed deferred
 *                                    decision ("out of scope for v0") → sub-check 4 fires
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { evaluateHandoff, evaluateHandoffWithState } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResultV2, StateMismatch } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): HandoffContext {
  return JSON.parse(
    readFileSync(join(root, 'data/fixtures/evals', name), 'utf8')
  ) as HandoffContext;
}

function getCategory(result: ReturnType<typeof evaluateHandoff>, name: string) {
  const cat = result.categories.find(c => c.name === name);
  assert.ok(cat, `Category '${name}' not found`);
  return cat;
}

interface MemoryRow { memory_id: string; memory_type: string; content: string; summary: string | null }
interface ProposalRow { proposal_id: string; memory_type: string; content: string; status: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPool(memories: MemoryRow[], proposals: ProposalRow[]): any {
  const responses = [{ rows: memories }, { rows: proposals }];
  let call = 0;
  return { query: async () => responses[call++] ?? { rows: [] } };
}

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

console.log('\nMutation Fixture Tests\n');

// ---------------------------------------------------------------------------
// mutation-stale-loop: completed task left in open_loops
// ---------------------------------------------------------------------------
// Mutation: added open_loop "TypeScript strict mode not yet applied to all modules"
//           AND added decision "TypeScript strict mode enabled as standard across all packages" (non-deferred).
//           Consistency sub-check 3 detects the stale loop.
// ---------------------------------------------------------------------------

test('stale-loop mutation: consistency deducts for stale open_loop', () => {
  const result = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.score < cat.max,
    `Expected consistency deduction. Got ${cat.score}/${cat.max}`
  );
  assert.ok(cat.notes.some(n => n.includes('stale')),
    `Expected a stale-loop note. Notes: ${cat.notes.join('; ')}`
  );
});

test('stale-loop mutation: exactly the TypeScript loop is detected as stale', () => {
  const result = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  assert.ok(
    result.failures.some(f => f.includes('[consistency]') && f.includes('stale')),
    `Expected [consistency] stale failure. Failures: ${result.failures.join('; ')}`
  );
});

test('stale-loop mutation: still passes overall despite stale loop (97/100)', () => {
  const result = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  assert.ok(result.pass,
    `Expected pass despite stale loop (score=${result.score_total})`
  );
});

test('stale-loop mutation: non-deferred authentication loop is NOT detected as stale', () => {
  // The authentication loop IS in open_loops, and "Authentication deferred to v1+" IS in decisions
  // — but that decision IS marked deferred (DEFER_SIGNAL matches), so stale check is skipped.
  const result = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  const cat = getCategory(result, 'consistency');
  // At most 1 stale loop (TypeScript), not 2 — deferred decisions don't trigger stale check
  const staleNote = cat.notes.find(n => n.includes('stale'));
  if (staleNote) {
    // "1 open loop(s) appear stale" — should be exactly 1, not 2
    assert.ok(staleNote.includes('1 open loop'),
      `Expected exactly 1 stale loop detected. Note: "${staleNote}"`
    );
  }
});

// ---------------------------------------------------------------------------
// mutation-missing-policy: committed policy silently dropped from global_policies
// ---------------------------------------------------------------------------
// Mutation: global_policies cleared to [].
// Pure evaluator: no score deduction — demonstrates evaluator's coverage gap.
// State-aware evaluator: missing_policy mismatch fires — DB is authoritative.
// ---------------------------------------------------------------------------

test('missing-policy mutation: pure evaluator gives full score (structural gap, not artifact defect)', () => {
  // This is intentional: the pure evaluator cannot know what policies should exist
  // without comparing against committed DB state. Score = 100.
  const result = evaluateHandoff(loadFixture('mutation-missing-policy.json'));
  assert.strictEqual(result.score_total, 100,
    `Pure evaluator should give 100 (no structural defect), got ${result.score_total}`
  );
  assert.ok(result.pass, 'Pure evaluator should pass');
});

test('missing-policy mutation: state-aware evaluator fires missing_policy mismatch', async () => {
  const pool = mockPool(
    // DB has the committed policy that the handoff dropped from global_policies
    [{ memory_id: 'mem_policy', memory_type: 'policy', content: 'All API responses must include X-Request-ID header. Unified policy.', summary: null }],
    []
  );
  const ctx = loadFixture('mutation-missing-policy.json');
  const result = await evaluateHandoffWithState(pool, ctx) as HandoffEvalResultV2;
  const mismatches: StateMismatch[] = result.state_consistency.mismatches;
  assert.ok(
    mismatches.some(m => m.mismatch_type === 'missing_policy'),
    `Expected missing_policy mismatch. Got: ${JSON.stringify(mismatches.map(m => m.mismatch_type))}`
  );
});

test('missing-policy mutation: domain phrase "request_id" links DB policy to section fingerprints', async () => {
  // The DB policy mentions X-Request-ID (→ "request_id" phrase token).
  // The fixture's global_policies is empty → missing_policy fires.
  // But if global_policies had "request ID" (English), the phrase token would create overlap.
  const pool = mockPool(
    [{ memory_id: 'mem_rid', memory_type: 'policy', content: 'X-Request-ID required on all API responses for tracing', summary: null }],
    []
  );
  const ctx = loadFixture('mutation-missing-policy.json');
  // global_policies is empty — no overlap possible — mismatch fires
  const result = await evaluateHandoffWithState(pool, ctx) as HandoffEvalResultV2;
  const m = result.state_consistency.mismatches.find(m => m.mismatch_type === 'missing_policy');
  assert.ok(m, 'Expected missing_policy when global_policies is empty');
  // Verify the DB fingerprint includes "request_id" domain phrase
  const dbRec = result.state_consistency.memory_topics_db.find(r => r.id === 'mem_rid');
  assert.ok(dbRec, 'Expected DB record for mem_rid');
  assert.ok(dbRec!.fingerprint.includes('request_id'),
    `Expected "request_id" phrase in fingerprint. Got: ${JSON.stringify(dbRec!.fingerprint)}`
  );
});

// ---------------------------------------------------------------------------
// mutation-design-first: design-first principle with impl-heavy strategic actions
// ---------------------------------------------------------------------------
// Mutation: relationship declares "Design-first principle: design locked before any code
//           is written" AND all strategic actions start with "Build:" (IMPL_VERB).
//           Consistency sub-check 5 fires.
// ---------------------------------------------------------------------------

test('design-first mutation: consistency sub-check 5 fires', () => {
  const result = evaluateHandoff(loadFixture('mutation-design-first.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.score < cat.max,
    `Expected consistency deduction from sub-check 5. Got ${cat.score}/${cat.max}`
  );
  assert.ok(cat.notes.some(n => n.includes('design-first')),
    `Expected design-first note. Notes: ${cat.notes.join('; ')}`
  );
});

test('design-first mutation: consistency is exactly 12 (only sub-check 5 deducts)', () => {
  // Sub-checks 1–4 should be clean: all "Build:" have valid verb, no roadmap in operational,
  // no stale loops, no deferred contradiction.
  const result = evaluateHandoff(loadFixture('mutation-design-first.json'));
  const cat = getCategory(result, 'consistency');
  assert.strictEqual(cat.score, 12,
    `Expected consistency=12 (15-3 for sub-check 5 only). Got ${cat.score}`
  );
});

test('design-first mutation: [consistency] failure appears in failures array', () => {
  const result = evaluateHandoff(loadFixture('mutation-design-first.json'));
  assert.ok(
    result.failures.some(f => f.startsWith('[consistency]') && f.includes('design-first')),
    `Expected [consistency] design-first failure. Failures: ${result.failures.join('; ')}`
  );
});

test('design-first mutation: still passes overall (presence sections compensate)', () => {
  const result = evaluateHandoff(loadFixture('mutation-design-first.json'));
  assert.ok(result.pass,
    `Expected pass despite sub-check 5 (score=${result.score_total})`
  );
});

// ---------------------------------------------------------------------------
// mutation-contradicting-pursue: Pursue action contradicts committed deferred decision
// ---------------------------------------------------------------------------
// Mutation: decision "Authentication system deferred to v1+. Out of scope for v0."
//           exists, but strategic has "Pursue: authentication system integration for
//           all v0 API endpoints". Consistency sub-check 4 fires.
//           Note: DEFER_SIGNAL v0.5 catches "Out of scope for v0" even without "deferred".
// ---------------------------------------------------------------------------

test('contradicting-pursue mutation: consistency sub-check 4 fires (Pursue vs deferred decision)', () => {
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.notes.some(n => n.includes('contradict')),
    `Expected contradiction note. Notes: ${cat.notes.join('; ')}`
  );
});

test('contradicting-pursue mutation: consistency is exactly 10 (only sub-check 4 deducts -5)', () => {
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  const cat = getCategory(result, 'consistency');
  assert.strictEqual(cat.score, 10,
    `Expected consistency=10 (15-5 for sub-check 4 only). Got ${cat.score}`
  );
});

test('contradicting-pursue mutation: [consistency] failure appears in failures array', () => {
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  assert.ok(
    result.failures.some(f => f.startsWith('[consistency]') && f.includes('contradict')),
    `Expected [consistency] contradiction failure. Failures: ${result.failures.join('; ')}`
  );
});

test('contradicting-pursue mutation: richer DEFER_SIGNAL catches "Out of scope for v0"', () => {
  // The decision contains "Out of scope for v0" — v0.5 DEFER_SIGNAL catches this.
  // v0.4 DEFER_SIGNAL only had: deferred|v1以降|later|後で|postponed|not yet|まだ
  // The decision also contains "deferred" which would catch it in v0.4, but "Out of scope"
  // is now independently recognized as a deferral signal.
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  // The key test: contradiction IS detected despite the decision using "Out of scope" phrasing
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.score < cat.max,
    'Expected deduction: "Out of scope" should be recognized as a deferral signal'
  );
});

test('contradicting-pursue mutation: still passes overall (95/100)', () => {
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  assert.ok(result.pass,
    `Expected pass despite contradiction (score=${result.score_total})`
  );
  assert.ok(result.score_total >= 90,
    `Expected score ≥ 90, got ${result.score_total}`
  );
});

// ---------------------------------------------------------------------------
// Domain phrase lexicon — cross-fixture coverage
// ---------------------------------------------------------------------------

test('domain phrase: "proposal → approval → commit" fingerprinted as proposal_approval_commit', async () => {
  // The valid-handoff global_policies says "Write path is proposal → approval → commit."
  // DB has a committed policy with the same phrase.
  // proposal_approval_commit phrase token should appear in both fingerprints → overlap.
  const pool = mockPool(
    [{ memory_id: 'mem_writepath', memory_type: 'policy', content: 'Write path is proposal → approval → commit. No AI direct writes.', summary: null }],
    []
  );
  const ctx = loadFixture('valid-handoff.json');
  const result = await evaluateHandoffWithState(pool, ctx) as HandoffEvalResultV2;
  const rec = result.state_consistency.memory_topics_db[0];
  assert.ok(rec.fingerprint.includes('proposal_approval_commit'),
    `Expected "proposal_approval_commit" phrase token. Got: ${JSON.stringify(rec.fingerprint)}`
  );
  // No missing_policy — phrase overlap creates match
  assert.ok(
    !result.state_consistency.mismatches.some(m => m.mismatch_type === 'missing_policy'),
    'Expected no missing_policy — phrase overlap should link DB policy to section'
  );
});

test('domain phrase: "world-class" / "世界標準" both resolve to world_standard token', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_ws', memory_type: 'policy', content: 'Build a world-class Memory OS — world standard for AI memory systems', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, loadFixture('valid-handoff.json')) as HandoffEvalResultV2;
  const rec = result.state_consistency.memory_topics_db[0];
  assert.ok(rec.fingerprint.includes('world_standard'),
    `Expected "world_standard" phrase token. Got: ${JSON.stringify(rec.fingerprint)}`
  );
});

test('domain phrase: "handoff quality" recognized in fingerprint', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_hq', memory_type: 'decision', content: 'Handoff quality is the primary metric for v0 completion', summary: null }],
    []
  );
  const result = await evaluateHandoffWithState(pool, loadFixture('valid-handoff.json')) as HandoffEvalResultV2;
  const rec = result.state_consistency.memory_topics_db[0];
  assert.ok(rec.fingerprint.includes('handoff_quality'),
    `Expected "handoff_quality" phrase token. Got: ${JSON.stringify(rec.fingerprint)}`
  );
});

// ---------------------------------------------------------------------------
// v1.0: failure_details with severity / fix_hint / auto_fixable per mutation
// ---------------------------------------------------------------------------

test('v1.0 stale-loop mutation: failure_detail has code=consistency_stale_loop, severity=warning', () => {
  const result = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  const d = result.failure_details.find(x => x.code === 'consistency_stale_loop');
  assert.ok(d, 'Expected consistency_stale_loop in failure_details');
  assert.strictEqual(d!.severity, 'warning');
  assert.strictEqual(d!.auto_fixable, false);
  assert.ok(d!.fix_hint.length > 20, 'fix_hint should be non-trivial');
});

test('v1.0 design-first mutation: failure_detail has code=consistency_design_first, severity=info', () => {
  const result = evaluateHandoff(loadFixture('mutation-design-first.json'));
  const d = result.failure_details.find(x => x.code === 'consistency_design_first');
  assert.ok(d, 'Expected consistency_design_first in failure_details');
  assert.strictEqual(d!.severity, 'info',
    'Design-first mismatch is advisory — next session is not actively harmed'
  );
  assert.strictEqual(d!.auto_fixable, false);
});

test('v1.0 contradicting-pursue mutation: failure_detail has code=consistency_contradiction, severity=critical', () => {
  const result = evaluateHandoff(loadFixture('mutation-contradicting-pursue.json'));
  const d = result.failure_details.find(x => x.code === 'consistency_contradiction');
  assert.ok(d, 'Expected consistency_contradiction in failure_details');
  assert.strictEqual(d!.severity, 'critical',
    'Active direction contradiction harms next session critically'
  );
  assert.strictEqual(d!.auto_fixable, false);
});

test('v1.0 missing-policy mutation: state-aware mismatch has critical severity and auto_fixable=true', async () => {
  const pool = mockPool(
    [{ memory_id: 'mem_xr', memory_type: 'policy', content: 'All API responses must include X-Request-ID header. Unified policy.', summary: null }],
    []
  );
  const ctx = loadFixture('mutation-missing-policy.json');
  const result = await evaluateHandoffWithState(pool, ctx) as HandoffEvalResultV2;
  const m = result.state_consistency.mismatches.find(x => x.mismatch_type === 'missing_policy');
  assert.ok(m, 'Expected missing_policy mismatch from state-aware evaluator');
  assert.strictEqual(m!.severity,     'critical');
  assert.strictEqual(m!.auto_fixable, true,
    'Policy IS in DB — re-running rebuild-context-cache would surface it → auto_fixable'
  );
});

test('v1.0: failure_details fix_hints are concrete (mention a command or section)', () => {
  // Every fix_hint should contain at least one actionable reference: a command or section name.
  const ACTION_REFS = /rebuild-context-cache|approve-proposal|commit-approved|propose|strategic|operational|relationship|identity|global_policies|active_project|open_loops/i;
  const staleResult = evaluateHandoff(loadFixture('mutation-stale-loop.json'));
  for (const d of staleResult.failure_details) {
    assert.ok(ACTION_REFS.test(d.fix_hint),
      `fix_hint for "${d.code}" lacks a concrete command or section reference: "${d.fix_hint}"`
    );
  }
});
