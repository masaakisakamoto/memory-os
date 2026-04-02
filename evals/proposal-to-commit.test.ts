/**
 * Proposal → commit test.
 */

import assert from 'assert';
import { validateProposalDoc, classify, dedupe } from '@memory-os/core-memory';
import { canAutoApprove } from '@memory-os/core-policy';

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

console.log('\nProposal → Commit Tests\n');

const validProposal = {
  proposal_id: 'prop_test_001',
  memory_type: 'episode',
  operation: 'create',
  proposed_content: 'Implemented raw ingest pipeline for Memory OS v0.',
  reason: 'Session completed core ingest job implementation.',
  created_at: new Date().toISOString(),
};

test('valid episode proposal passes validation', () => {
  const result = validateProposalDoc(validProposal);
  assert.ok(result.valid, `Expected valid. Errors: ${JSON.stringify(result.errors)}`);
  assert.ok(result.policy_allows, 'Expected policy to allow episode');
});

test('episode proposals are auto-approvable', () => {
  const result = validateProposalDoc(validProposal);
  assert.ok(result.auto_approvable, 'Expected episode to be auto-approvable');
});

test('identity proposals require human approval', () => {
  const canAuto = canAutoApprove('identity', 0.95, 'low');
  assert.strictEqual(canAuto, false, 'Expected identity to require human approval');
});

test('policy proposals require human approval', () => {
  const canAuto = canAutoApprove('policy', 0.95, 'low');
  assert.strictEqual(canAuto, false, 'Expected policy to require human approval');
});

test('high risk proposals cannot be auto-approved', () => {
  const canAuto = canAutoApprove('episode', 0.9, 'high');
  assert.strictEqual(canAuto, false, 'Expected high risk to block auto-approve');
});

test('classifier identifies policy content correctly', () => {
  const result = classify('今後はすべてのAPIレスポンスにX-Request-IDヘッダーを含めます。この方針で統一します。');
  assert.strictEqual(result.memory_type, 'policy', `Expected policy, got ${result.memory_type}`);
  assert.ok(result.confidence > 0.5, `Expected confidence > 0.5, got ${result.confidence}`);
});

test('deduper detects near-identical content as duplicate', () => {
  const result = dedupe(
    'All API responses must include a request ID.',
    'policy',
    [{ memory_id: 'mem_001', content: 'All API responses must include a request ID.', memory_type: 'policy' }]
  );
  assert.ok(result.is_duplicate, 'Expected duplicate detection');
  assert.strictEqual(result.duplicate_of, 'mem_001');
});

test('deduper does not flag different types as duplicates', () => {
  const result = dedupe(
    'All API responses must include a request ID.',
    'policy',
    [{ memory_id: 'mem_001', content: 'All API responses must include a request ID.', memory_type: 'episode' }]
  );
  assert.ok(!result.is_duplicate, 'Expected no duplicate (different types)');
});

test('missing required field fails validation', () => {
  const badProposal = {
    proposal_id: 'prop_bad_001',
    memory_type: 'episode',
    operation: 'create',
  };
  const result = validateProposalDoc(badProposal);
  assert.ok(!result.valid, 'Expected validation to fail for missing fields');
});
