import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tests = [
  'schema-validation.test.ts',
  'raw-to-proposal.test.ts',
  'proposal-to-commit.test.ts',
  'handoff-context.test.ts',
  'handoff-eval.test.ts',
  'handoff-eval-state.test.ts',
  'mutation-fixtures.test.ts',
  'repair-loop.test.ts',
];

let allPassed = true;

for (const testFile of tests) {
  console.log(`\nRunning: ${testFile}`);
  const result = spawnSync('tsx', [testFile], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    allPassed = false;
  }
}

console.log(allPassed ? '\nAll tests passed.' : '\nSome tests failed.');
process.exit(allPassed ? 0 : 1);
