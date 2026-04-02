/**
 * Handoff quality evaluator tests.
 *
 * All tests are fixture-based and deterministic — no DB, no LLM.
 *
 * Fixtures and their failure mode:
 *   valid-handoff.json          — all sections correct, clean mapping            → PASS, score ≥ 75
 *   stale-handoff.json          — no committed memories, fallback message         → FAIL, freshness + decisions = 0
 *   missing-decisions-handoff   — no decisions or strategic actions               → FAIL, decision_preservation = 0
 *   noisy-handoff.json          — cross-section contamination                     → noise_control = 0
 *   contradicting-handoff.json  — internally consistent-looking but WRONG:        → consistency low, failures non-empty
 *                                 pursues deferred decision, stale open loop,
 *                                 roadmap in operational, missing action verbs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { evaluateHandoff, PASS_THRESHOLD } from '@memory-os/core-context';
import type { HandoffContext, HandoffEvalResult } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadFixture(name: string): HandoffContext {
  return JSON.parse(
    readFileSync(join(root, 'data/fixtures/evals', name), 'utf8')
  ) as HandoffContext;
}

function getCategory(result: HandoffEvalResult, name: string) {
  const cat = result.categories.find(c => c.name === name);
  assert.ok(cat, `Category '${name}' not found in eval result`);
  return cat;
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

console.log('\nHandoff Eval Tests\n');

// ---------------------------------------------------------------------------
// valid-handoff: all sections populated, clean mapping
// ---------------------------------------------------------------------------

test('valid handoff: evaluator returns a well-formed result', () => {
  const ctx = loadFixture('valid-handoff.json');
  const result = evaluateHandoff(ctx);
  assert.ok(result.eval_id.startsWith('eval_'), 'eval_id should start with eval_');
  assert.strictEqual(result.context_id, ctx.context_id);
  assert.strictEqual(result.score_max, 100);
  assert.strictEqual(result.pass_threshold, PASS_THRESHOLD);
  assert.ok(typeof result.evaluated_at === 'string');
  assert.ok(Array.isArray(result.categories) && result.categories.length === 8);
  assert.ok(Array.isArray(result.failures));
  assert.ok(Array.isArray(result.recommendations));
});

test('valid handoff: passes with score >= 75', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  assert.ok(result.pass, `Expected pass but got fail (score=${result.score_total})`);
  assert.ok(result.score_total >= 75, `Expected score >= 75, got ${result.score_total}`);
});

test('valid handoff: continuity_accuracy full score', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  const cat = getCategory(result, 'continuity_accuracy');
  assert.strictEqual(cat.score, cat.max, `continuity_accuracy=${cat.score}/${cat.max}`);
});

test('valid handoff: consistency full score (no issues detected)', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  const cat = getCategory(result, 'consistency');
  assert.strictEqual(cat.score, cat.max, `consistency=${cat.score}/${cat.max}`);
});

test('valid handoff: no failures', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  assert.strictEqual(result.failures.length, 0, `Expected 0 failures, got: ${result.failures.join('; ')}`);
});

test('valid handoff: noise_control full score', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  const cat = getCategory(result, 'noise_control');
  assert.strictEqual(cat.score, cat.max, `noise_control=${cat.score}/${cat.max}`);
});

test('valid handoff: relationship_quality full score (style and authority signals present)', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  const cat = getCategory(result, 'relationship_quality');
  assert.strictEqual(cat.score, cat.max, `relationship_quality=${cat.score}/${cat.max}`);
});

// ---------------------------------------------------------------------------
// stale-handoff: no committed memories, fallback project message
// ---------------------------------------------------------------------------

test('stale handoff: fails overall', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  assert.ok(!result.pass, `Expected fail but got pass (score=${result.score_total})`);
});

test('stale handoff: state_freshness is 0', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  const cat = getCategory(result, 'state_freshness');
  assert.strictEqual(cat.score, 0, `Expected state_freshness=0, got ${cat.score}`);
});

test('stale handoff: decision_preservation is 0', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  const cat = getCategory(result, 'decision_preservation');
  assert.strictEqual(cat.score, 0, `Expected decision_preservation=0, got ${cat.score}`);
});

test('stale handoff: actionability is 0', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  const cat = getCategory(result, 'actionability');
  assert.strictEqual(cat.score, 0, `Expected actionability=0, got ${cat.score}`);
});

test('stale handoff: failures include source_memories and active_project messages', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  assert.ok(result.failures.some(f => f.includes('source_memories')), 'Expected a failure about source_memories');
  assert.ok(result.failures.some(f => f.includes('active_project')), 'Expected a failure about active_project');
});

test('stale handoff: relationship_quality partial (content exists but no style/authority signals)', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  const cat = getCategory(result, 'relationship_quality');
  assert.ok(cat.score > 0, `Expected partial relationship_quality, got 0`);
  assert.ok(cat.score < cat.max, `Expected partial relationship_quality, got full ${cat.score}/${cat.max}`);
});

// ---------------------------------------------------------------------------
// missing-decisions-handoff: no decisions, no strategic actions
// ---------------------------------------------------------------------------

test('missing-decisions handoff: fails overall', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  assert.ok(!result.pass, `Expected fail but got pass (score=${result.score_total})`);
});

test('missing-decisions handoff: decision_preservation is 0', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  const cat = getCategory(result, 'decision_preservation');
  assert.strictEqual(cat.score, 0, `Expected decision_preservation=0, got ${cat.score}`);
});

test('missing-decisions handoff: actionability is partial (operational present, strategic absent)', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  const cat = getCategory(result, 'actionability');
  assert.ok(cat.score > 0, 'Expected some actionability score from operational_next_actions');
  assert.ok(cat.score < cat.max, `Expected partial actionability, got ${cat.score}/${cat.max}`);
});

test('missing-decisions handoff: failures include relevant_decisions and strategic_next_actions', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  assert.ok(result.failures.some(f => f.includes('relevant_decisions')), 'Expected a failure about relevant_decisions');
  assert.ok(result.failures.some(f => f.includes('strategic_next_actions')), 'Expected a failure about strategic_next_actions');
});

test('missing-decisions handoff: continuity_accuracy is partial (active_project ok, decisions missing)', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  const cat = getCategory(result, 'continuity_accuracy');
  assert.ok(cat.score > 0, 'Should have partial continuity from active_project and relationship');
  assert.ok(cat.score < cat.max, `Expected partial score, got full ${cat.score}/${cat.max}`);
});

test('missing-decisions handoff: consistency is full score (no wrong content, just absent)', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  const cat = getCategory(result, 'consistency');
  assert.strictEqual(cat.score, cat.max,
    `consistency should be full when content is absent (not wrong); got ${cat.score}/${cat.max}`
  );
});

test('missing-decisions handoff: relationship_quality is 0 (generic boilerplate)', () => {
  const result = evaluateHandoff(loadFixture('missing-decisions-handoff.json'));
  const cat = getCategory(result, 'relationship_quality');
  assert.strictEqual(cat.score, 0, `Expected relationship_quality=0 for generic boilerplate, got ${cat.score}`);
});

// ---------------------------------------------------------------------------
// noisy-handoff: cross-section contamination
// ---------------------------------------------------------------------------

test('noisy handoff: noise_control is 0 (all three contaminations detected)', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  const cat = getCategory(result, 'noise_control');
  assert.strictEqual(cat.score, 0, `Expected noise_control=0, got ${cat.score}`);
});

test('noisy handoff: failures include identity-in-relationship, policy-in-active_project, approval-in-strategic', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  assert.ok(result.failures.some(f => f.includes('relationship') && f.includes('identity')), 'Expected: identity in relationship');
  assert.ok(result.failures.some(f => f.includes('active_project') && f.includes('policy')), 'Expected: policy in active_project');
  assert.ok(result.failures.some(f => f.includes('strategic_next_actions') && f.includes('approval')), 'Expected: approval in strategic');
});

test('noisy handoff: decision_preservation intact despite noise (decisions and strategic populated)', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  const cat = getCategory(result, 'decision_preservation');
  assert.strictEqual(cat.score, cat.max, `Expected full decision_preservation despite noise, got ${cat.score}/${cat.max}`);
});

test('noisy handoff: state_freshness reasonable (4 source_memories)', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  const cat = getCategory(result, 'state_freshness');
  assert.ok(cat.score >= 4, `Expected state_freshness >= 4 with 4 source_memories, got ${cat.score}`);
});

test('noisy handoff: relationship_quality is 0 (identity contamination)', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  const cat = getCategory(result, 'relationship_quality');
  assert.strictEqual(cat.score, 0, `Expected relationship_quality=0 due to identity contamination, got ${cat.score}`);
});

// ---------------------------------------------------------------------------
// contradicting-handoff: passes presence checks but is internally WRONG
//   - "Pursue: authentication" contradicts "authentication deferred to v1+"
//   - "Deploy to production" lacks action verb
//   - "Execute A→B staged v1 migration" is roadmap language in operational
//   - "TypeScript strict mode not yet applied" is stale (non-deferred decision covers same topic)
// ---------------------------------------------------------------------------

test('contradicting handoff: consistency score is low (all four sub-checks fire)', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.score <= 5,
    `Expected consistency <= 5 (all four deductions), got ${cat.score}/${cat.max}`
  );
});

test('contradicting handoff: action verb violation detected', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'consistency');
  const hasVerbViolation = cat.notes.some(n => n.includes('action verb'));
  assert.ok(hasVerbViolation, 'Expected action verb violation in consistency notes');
});

test('contradicting handoff: roadmap contamination in operational detected', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'consistency');
  const hasRoadmap = cat.notes.some(n => n.includes('roadmap'));
  assert.ok(hasRoadmap, 'Expected roadmap contamination in consistency notes');
});

test('contradicting handoff: stale open loop detected', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'consistency');
  const hasStale = cat.notes.some(n => n.includes('stale'));
  assert.ok(hasStale, 'Expected stale open loop in consistency notes');
});

test('contradicting handoff: strategic contradicts deferred decision detected', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'consistency');
  const hasContradiction = cat.notes.some(n => n.includes('contradict'));
  assert.ok(hasContradiction, 'Expected contradiction in consistency notes');
});

test('contradicting handoff: consistency failures appear in failures array', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const consistencyFailures = result.failures.filter(f => f.startsWith('[consistency]'));
  assert.ok(consistencyFailures.length >= 3,
    `Expected >= 3 [consistency] failures, got ${consistencyFailures.length}: ${consistencyFailures.join('; ')}`
  );
});

test('contradicting handoff: presence checks pass (continuity_accuracy and decision_preservation are high)', () => {
  // Confirms the evaluator detects wrongness that presence-only checks miss
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const continuity = getCategory(result, 'continuity_accuracy');
  const decisions  = getCategory(result, 'decision_preservation');
  assert.ok(continuity.score >= 18, `continuity_accuracy should be high (sections populated), got ${continuity.score}`);
  assert.ok(decisions.score >= 18,  `decision_preservation should be high (decisions present), got ${decisions.score}`);
});

test('contradicting handoff: relationship_quality is 0 (generic boilerplate)', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const cat = getCategory(result, 'relationship_quality');
  assert.strictEqual(cat.score, 0, `Expected relationship_quality=0 for generic boilerplate, got ${cat.score}`);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// design-first-handoff: relationship signals design-first, strategic actions all impl-heavy
//   - sub-check 5 fires: all strategic start with Build (IMPL_VERB) and relationship
//     contains "Design locked before implementation" (DESIGN_FIRST_SIGNAL)
//   - sub-checks 1–4 clean (all strategic start with "Build:", no roadmap, etc.)
// ---------------------------------------------------------------------------

test('design-first handoff: consistency sub-check 5 fires (design-first vs impl-heavy)', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.score < cat.max,
    `Expected consistency deduction for design-first vs impl-heavy, got ${cat.score}/${cat.max}`
  );
  assert.ok(cat.score >= 12,
    `Expected consistency=12 (only sub-check 5 fires, -3), got ${cat.score}`
  );
});

test('design-first handoff: consistency note mentions design-first principle', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  const cat = getCategory(result, 'consistency');
  assert.ok(cat.notes.some(n => n.includes('design-first')),
    `Expected a note mentioning "design-first". Notes: ${cat.notes.join('; ')}`
  );
});

test('design-first handoff: consistency failure appears in failures array', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  assert.ok(result.failures.some(f => f.includes('[consistency]') && f.includes('design-first')),
    `Expected [consistency] design-first failure. Failures: ${result.failures.join('; ')}`
  );
});

test('design-first handoff: passes overall (presence-heavy sections compensate)', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  assert.ok(result.pass,
    `Expected pass despite sub-check 5 (score=${result.score_total})`
  );
});

test('design-first handoff: valid sections are clean (sub-checks 1–4 silent)', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  const cat = getCategory(result, 'consistency');
  // Only sub-check 5 deducts (-3), so score must be exactly 12
  assert.strictEqual(cat.score, 12,
    `Expected consistency=12 (only -3 from sub-check 5), got ${cat.score}`
  );
});

// ---------------------------------------------------------------------------
// Structural invariants across all fixtures
// ---------------------------------------------------------------------------

const allFixtures = [
  'valid-handoff.json',
  'stale-handoff.json',
  'missing-decisions-handoff.json',
  'noisy-handoff.json',
  'contradicting-handoff.json',
  'design-first-handoff.json',
];

test('all fixtures: evaluator produces exactly 8 categories', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    assert.strictEqual(result.categories.length, 8,
      `${name}: expected 8 categories, got ${result.categories.length}`
    );
  }
});

test('all fixtures: score_total is sum of category scores', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    const sum = result.categories.reduce((s, c) => s + c.score, 0);
    assert.strictEqual(result.score_total, sum,
      `${name}: score_total=${result.score_total} != sum=${sum}`
    );
  }
});

test('all fixtures: no category score exceeds its max', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    for (const cat of result.categories) {
      assert.ok(cat.score <= cat.max,
        `${name}: ${cat.name} score ${cat.score} exceeds max ${cat.max}`
      );
    }
  }
});

test('all fixtures: score_total is between 0 and 100', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    assert.ok(result.score_total >= 0, `${name}: score_total < 0`);
    assert.ok(result.score_total <= 100, `${name}: score_total > 100`);
  }
});

test('all fixtures: category maxes sum to 100', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    const maxSum = result.categories.reduce((s, c) => s + c.max, 0);
    assert.strictEqual(maxSum, 100,
      `${name}: category maxes sum to ${maxSum}, expected 100`
    );
  }
});

// ---------------------------------------------------------------------------
// v1.0: failure_details structure (all fixtures)
// ---------------------------------------------------------------------------

test('all fixtures: failure_details is an array', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    assert.ok(Array.isArray(result.failure_details),
      `${name}: failure_details should be an array`
    );
  }
});

test('all fixtures: each failure_detail has required v1.0 fields', () => {
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    for (const d of result.failure_details) {
      assert.ok(typeof d.code === 'string' && d.code.length > 0,       `${name}: code must be non-empty string`);
      assert.ok(typeof d.message === 'string' && d.message.length > 0, `${name}: message must be non-empty string`);
      assert.ok(['critical', 'warning', 'info'].includes(d.severity),  `${name}: severity must be critical|warning|info, got "${d.severity}"`);
      assert.ok(typeof d.fix_hint === 'string' && d.fix_hint.length > 0, `${name}: fix_hint must be non-empty string`);
      assert.ok(typeof d.auto_fixable === 'boolean',                   `${name}: auto_fixable must be boolean`);
    }
  }
});

test('all fixtures: failure_details length matches failures length', () => {
  // failure_details is a parallel array to failures[] — same number of entries.
  for (const name of allFixtures) {
    const result = evaluateHandoff(loadFixture(name));
    assert.strictEqual(result.failure_details.length, result.failures.length,
      `${name}: failure_details.length (${result.failure_details.length}) ≠ failures.length (${result.failures.length})`
    );
  }
});

test('valid handoff: failure_details is empty (no issues detected)', () => {
  const result = evaluateHandoff(loadFixture('valid-handoff.json'));
  assert.strictEqual(result.failure_details.length, 0,
    `Expected 0 failure_details, got: ${result.failure_details.map(d => d.code).join(', ')}`
  );
});

test('stale handoff: critical failure_details present for empty sections', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  const codes = result.failure_details.map(d => d.code);
  assert.ok(codes.includes('active_project_empty'),   'Expected active_project_empty');
  assert.ok(codes.includes('decisions_empty'),         'Expected decisions_empty');
  assert.ok(codes.includes('source_memories_empty'),   'Expected source_memories_empty');
  // All three are critical
  for (const code of ['active_project_empty', 'decisions_empty', 'source_memories_empty']) {
    const d = result.failure_details.find(x => x.code === code)!;
    assert.strictEqual(d.severity, 'critical', `Expected ${code} to be critical`);
  }
});

test('stale handoff: all critical failure_details have auto_fixable=false', () => {
  const result = evaluateHandoff(loadFixture('stale-handoff.json'));
  for (const d of result.failure_details.filter(x => x.severity === 'critical')) {
    assert.strictEqual(d.auto_fixable, false,
      `${d.code}: critical pure-evaluator failures require human action, auto_fixable must be false`
    );
  }
});

test('noisy handoff: contamination failures are severity=warning', () => {
  const result = evaluateHandoff(loadFixture('noisy-handoff.json'));
  const contaminated = result.failure_details.filter(d =>
    d.code === 'relationship_contaminated' ||
    d.code === 'active_project_contaminated' ||
    d.code === 'strategic_contaminated'
  );
  assert.ok(contaminated.length > 0, 'Expected at least one contamination failure_detail');
  for (const d of contaminated) {
    assert.strictEqual(d.severity, 'warning', `Expected ${d.code} to be warning`);
  }
});

test('contradicting handoff: consistency_contradiction is severity=critical', () => {
  const result = evaluateHandoff(loadFixture('contradicting-handoff.json'));
  const contradiction = result.failure_details.find(d => d.code === 'consistency_contradiction');
  assert.ok(contradiction, 'Expected consistency_contradiction failure_detail');
  assert.strictEqual(contradiction!.severity, 'critical');
});

test('design-first handoff: consistency_design_first is severity=info', () => {
  const result = evaluateHandoff(loadFixture('design-first-handoff.json'));
  const hint = result.failure_details.find(d => d.code === 'consistency_design_first');
  assert.ok(hint, 'Expected consistency_design_first failure_detail');
  assert.strictEqual(hint!.severity, 'info');
});
