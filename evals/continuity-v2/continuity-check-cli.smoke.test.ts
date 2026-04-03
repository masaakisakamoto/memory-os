import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

function runContinuityCheck(text: string): string {
  return execFileSync(
    "tsx",
    ["cli/continuity-check.ts", "--text", text],
    {
      encoding: "utf-8",
      env: process.env,
    },
  )
}

test("continuity-check CLI: state mismatch smoke test", () => {
  const stdout = runContinuityCheck("次は handoff quality を詰めたい")

  assert.match(stdout, /=== continuity-check result ===/)
  assert.match(stdout, /action: allow_with_visible_suggestion/)
  assert.match(stdout, /severity: error/)
  assert.match(stdout, /issues: 1/)
})

test("continuity-check CLI: ambiguous reference smoke test", () => {
  const stdout = runContinuityCheck("これを進めたい")

  assert.match(stdout, /=== continuity-check result ===/)
  assert.match(stdout, /action: allow_with_visible_suggestion/)
  assert.match(stdout, /severity: warn/)
  assert.match(stdout, /issues: 1/)
})

test("continuity-check CLI: policy violation smoke test", () => {
  const stdout = runContinuityCheck("approveなしで反映して")

  assert.match(stdout, /=== continuity-check result ===/)
  assert.match(stdout, /action: block_due_to_policy/)
  assert.match(stdout, /severity: block/)
  assert.match(stdout, /issues: 1/)
})
