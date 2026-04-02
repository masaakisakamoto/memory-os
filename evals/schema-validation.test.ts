/**
 * Schema validation tests — validates fixture files against JSON schemas.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

function loadJSON(relPath: string) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
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

console.log('\nSchema Validation Tests\n');

// Load schemas
const memorySchema = loadJSON('core/schemas/memory.schema.json');
const proposalSchema = loadJSON('core/schemas/proposal.schema.json');
const commitSchema = loadJSON('core/schemas/commit.schema.json');
const contextSchema = loadJSON('core/schemas/context.schema.json');

const validateMemory = ajv.compile(memorySchema);
const validateProposal = ajv.compile(proposalSchema);
const validateCommit = ajv.compile(commitSchema);
const validateContext = ajv.compile(contextSchema);

// Test: proposal fixture
test('sample-proposal.json validates against proposal.schema.json', () => {
  const doc = loadJSON('data/fixtures/proposals/sample-proposal.json');
  const valid = validateProposal(doc);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateProposal.errors)}`);
});

// Test: commit fixture
test('sample-commit.json validates against commit.schema.json', () => {
  const doc = loadJSON('data/fixtures/commits/sample-commit.json');
  const valid = validateCommit(doc);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateCommit.errors)}`);
});

// Test: context fixture
test('sample-handoff-context.json validates against context.schema.json', () => {
  const doc = loadJSON('data/fixtures/contexts/sample-handoff-context.json');
  const valid = validateContext(doc);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateContext.errors)}`);
});

// Test: minimal valid memory
test('minimal valid memory passes schema', () => {
  const mem = {
    memory_id: 'mem_test_001',
    memory_type: 'policy',
    content: 'Test policy content',
    trust_level: 't2_validated',
    status: 'active',
    created_at: new Date().toISOString(),
  };
  const valid = validateMemory(mem);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateMemory.errors)}`);
});

// Test: invalid memory (bad memory_type) fails
test('invalid memory_type fails schema validation', () => {
  const mem = {
    memory_id: 'mem_test_002',
    memory_type: 'not_a_real_type',
    content: 'Test',
    trust_level: 't2_validated',
    status: 'active',
    created_at: new Date().toISOString(),
  };
  const valid = validateMemory(mem);
  assert.ok(!valid, 'Expected validation to fail for invalid memory_type');
});

// Test: invalid trust_level fails
test('invalid trust_level fails schema validation', () => {
  const mem = {
    memory_id: 'mem_test_003',
    memory_type: 'policy',
    content: 'Test',
    trust_level: 'invalid_level',
    status: 'active',
    created_at: new Date().toISOString(),
  };
  const valid = validateMemory(mem);
  assert.ok(!valid, 'Expected validation to fail for invalid trust_level');
});
