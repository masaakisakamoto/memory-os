/**
 * Raw → proposal fixture test.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { extractProposals } from '@memory-os/core-memory';
import type { RawEvent } from '@memory-os/core-memory';

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

console.log('\nRaw → Proposal Tests\n');

const sessionFile = JSON.parse(
  readFileSync(join(root, 'data/fixtures/raw/sample-session.json'), 'utf8')
);

const events: RawEvent[] = sessionFile.events.map((e: RawEvent) => ({
  ...e,
  session_id: sessionFile.session_id,
}));

const proposals = extractProposals(events, sessionFile.session_id);

test('extractor produces at least one proposal', () => {
  assert.ok(proposals.length > 0, `Expected proposals, got ${proposals.length}`);
});

test('all proposals have required fields', () => {
  for (const p of proposals) {
    assert.ok(p.proposal_id, 'Missing proposal_id');
    assert.ok(p.memory_type, 'Missing memory_type');
    assert.ok(p.operation, 'Missing operation');
    assert.ok(p.proposed_content, 'Missing proposed_content');
    assert.ok(p.reason, 'Missing reason');
    assert.ok(p.created_at, 'Missing created_at');
  }
});

test('policy proposal extracted from evt_001 (explicit signal: この方針で)', () => {
  const policyProps = proposals.filter(p => p.memory_type === 'policy');
  assert.ok(policyProps.length > 0, 'Expected at least one policy proposal');
  const p = policyProps[0];
  assert.ok(p.confidence >= 0.7, `Expected confidence >= 0.7, got ${p.confidence}`);
});

test('all proposals only come from user events', () => {
  for (const p of proposals) {
    const sourceEvent = events.find(e => p.source_refs.some(ref => ref.includes(e.event_id)));
    if (sourceEvent) {
      assert.strictEqual(sourceEvent.role, 'user', `Expected user event, got ${sourceEvent.role}`);
    }
  }
});

test('proposals have valid operation values', () => {
  const validOps = ['create', 'update', 'supersede', 'invalidate'];
  for (const p of proposals) {
    assert.ok(validOps.includes(p.operation), `Invalid operation: ${p.operation}`);
  }
});

test('proposal confidence is between 0 and 1', () => {
  for (const p of proposals) {
    assert.ok(p.confidence >= 0 && p.confidence <= 1, `Confidence out of range: ${p.confidence}`);
  }
});
