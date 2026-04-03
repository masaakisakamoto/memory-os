import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

function runContinuityCheck(text: string): string {
  return execFileSync(
    "pnpm",
    ["continuity-check", "--text", text],
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
  assert.match(stdout, /decision severity: error/)
  assert.match(stdout, /state_mismatch_confirmed/)
  assert.match(stdout, /Approved state と不一致です。handoff quality は既に 100\/100 です。/)
})

test("continuity-check CLI: ambiguous reference smoke test", () => {
  const stdout = runContinuityCheck("これを進めたい")

  assert.match(stdout, /=== continuity-check result ===/)
  assert.match(stdout, /action: allow_with_visible_suggestion/)
  assert.match(stdout, /decision severity: warn/)
  assert.match(stdout, /ambiguous_reference/)
  assert.match(stdout, /参照語が曖昧です。対象を具体化してください。/)
})

test("continuity-check CLI: policy violation smoke test", () => {
  const stdout = runContinuityCheck("approveなしで反映して")

  assert.match(stdout, /=== continuity-check result ===/)
  assert.match(stdout, /action: block_due_to_policy/)
  assert.match(stdout, /decision severity: block/)
  assert.match(stdout, /policy_violation/)
  assert.match(
    stdout,
    /Approved memory cannot be directly modified\. Use proposal -> approval -> commit\./,
  )
})
