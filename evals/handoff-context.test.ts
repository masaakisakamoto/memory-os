/**
 * Handoff context build test.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { resolveIntent, planScope, determineCompressionLevel } from '@memory-os/core-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

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

console.log('\nHandoff Context Tests\n');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const contextSchema = JSON.parse(
  readFileSync(join(root, 'core/schemas/context.schema.json'), 'utf8')
);
const validateContext = ajv.compile(contextSchema);

const fixtureContext = JSON.parse(
  readFileSync(join(root, 'data/fixtures/contexts/sample-handoff-context.json'), 'utf8')
);

test('sample-handoff-context.json validates against context.schema.json', () => {
  const valid = validateContext(fixtureContext);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateContext.errors)}`);
});

test('resolveIntent defaults to handoff', () => {
  const resolution = resolveIntent({});
  assert.strictEqual(resolution.intent, 'handoff');
  assert.strictEqual(resolution.role, 'assistant');
});

test('resolveIntent respects explicit intent', () => {
  const resolution = resolveIntent({ intent: 'task' });
  assert.strictEqual(resolution.intent, 'task');
});

test('resolveIntent infers handoff from query keyword', () => {
  const resolution = resolveIntent({ query: 'build a handoff for next session' });
  assert.strictEqual(resolution.intent, 'handoff');
});

test('planScope produces all 12 required sections (including strategic/operational_next_actions and open_loops)', () => {
  const scope = planScope('handoff', 2000);
  const required = [
    'identity', 'relationship', 'global_policies', 'active_project',
    'relevant_decisions', 'procedures', 'recent_episodes', 'evidence',
    'task_frame', 'strategic_next_actions', 'operational_next_actions', 'open_loops',
  ];
  for (const section of required) {
    assert.ok(scope.sections[section], `Missing section: ${section}`);
  }
});

test('planScope strategic/operational_next_actions and open_loops have empty memory_types (synthesized)', () => {
  const scope = planScope('handoff', 2000);
  assert.deepStrictEqual(scope.sections['strategic_next_actions'].memory_types, []);
  assert.deepStrictEqual(scope.sections['operational_next_actions'].memory_types, []);
  assert.deepStrictEqual(scope.sections['open_loops'].memory_types, []);
});

test('planScope relationship has fallback_memory_types and does not fall back to identity', () => {
  const scope = planScope('handoff', 2000);
  const fallback = scope.sections['relationship'].fallback_memory_types ?? [];
  assert.ok(fallback.length > 0, 'relationship should have fallback_memory_types');
  assert.ok(!fallback.includes('identity'), 'relationship must not fall back to identity (different semantic)');
});

test('planScope handoff: relationship has higher priority than identity', () => {
  const scope = planScope('handoff', 2000);
  assert.ok(
    scope.sections['relationship'].priority < scope.sections['identity'].priority,
    `relationship priority (${scope.sections['relationship'].priority}) should be less than identity (${scope.sections['identity'].priority})`
  );
});

test('planScope respects token budget (total ≈ target)', () => {
  const target = 2000;
  const scope = planScope('handoff', target);
  const total = Object.values(scope.sections).reduce((s, v) => s + v.token_budget, 0);
  // Allow ±10% for rounding
  assert.ok(Math.abs(total - target) / target < 0.1, `Budget mismatch: ${total} vs ${target}`);
});

test('compressionLevel is none when under budget', () => {
  assert.strictEqual(determineCompressionLevel(800, 1000), 'none');
});

test('compressionLevel is light when 0-30% over budget', () => {
  assert.strictEqual(determineCompressionLevel(1200, 1000), 'light');
});

test('compressionLevel is aggressive when >30% over budget', () => {
  assert.strictEqual(determineCompressionLevel(1500, 1000), 'aggressive');
});

test('fixture context has all section keys including strategic/operational_next_actions and open_loops', () => {
  const required = [
    'identity', 'relationship', 'global_policies', 'active_project',
    'relevant_decisions', 'procedures', 'recent_episodes', 'evidence',
    'strategic_next_actions', 'operational_next_actions', 'open_loops',
  ];
  for (const key of required) {
    assert.ok(key in fixtureContext.sections, `Missing section key: ${key}`);
  }
});

test('fixture strategic_next_actions, operational_next_actions, and open_loops are non-empty arrays', () => {
  assert.ok(
    Array.isArray(fixtureContext.sections.strategic_next_actions) &&
    fixtureContext.sections.strategic_next_actions.length > 0,
    'strategic_next_actions should be a non-empty array in fixture'
  );
  assert.ok(
    Array.isArray(fixtureContext.sections.operational_next_actions) &&
    fixtureContext.sections.operational_next_actions.length > 0,
    'operational_next_actions should be a non-empty array in fixture'
  );
  assert.ok(
    Array.isArray(fixtureContext.sections.open_loops) &&
    fixtureContext.sections.open_loops.length > 0,
    'open_loops should be a non-empty array in fixture'
  );
});
