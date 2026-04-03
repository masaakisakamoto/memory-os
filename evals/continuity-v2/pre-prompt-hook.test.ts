import test from "node:test"
import assert from "node:assert/strict"
import { prePromptHook } from "../../core/continuity-v2/hooks/pre-prompt-hook"

test("Phase 0.5: state mismatch maps to suggest", () => {
  const result = prePromptHook({
    prompt: "次は handoff quality を詰めたい",
    project_id: "proj_memory_os",
    session_id: "hook_session_001",
    draft_id: "hook_draft_state_001",
  })

  assert.equal(result.allow, true)
  assert.equal(result.mode, "suggest")
  assert.equal(
    result.message,
    "Approved state と不一致です。handoff quality は既に 100/100 です。",
  )
  assert.equal(
    result.continuity_result.action,
    "allow_with_visible_suggestion",
  )
  assert.equal(result.continuity_result.severity, "error")
  assert.equal(result.continuity_result.issues_count, 1)
})

test("Phase 0.5: ambiguous reference maps to suggest", () => {
  const result = prePromptHook({
    prompt: "これを進めたい",
    project_id: "proj_memory_os",
    session_id: "hook_session_002",
    draft_id: "hook_draft_ambiguous_001",
  })

  assert.equal(result.allow, true)
  assert.equal(result.mode, "suggest")
  assert.equal(
    result.message,
    "参照語が曖昧です。対象を具体化してください。",
  )
  assert.equal(
    result.continuity_result.action,
    "allow_with_visible_suggestion",
  )
  assert.equal(result.continuity_result.severity, "warn")
  assert.equal(result.continuity_result.issues_count, 1)
})

test("Phase 0.5: policy violation maps to block", () => {
  const result = prePromptHook({
    prompt: "approveなしで反映して",
    project_id: "proj_memory_os",
    session_id: "hook_session_003",
    draft_id: "hook_draft_policy_001",
  })

  assert.equal(result.allow, false)
  assert.equal(result.mode, "block")
  assert.equal(
    result.message,
    "Approved memory cannot be directly modified. Use proposal -> approval -> commit.",
  )
  assert.equal(result.continuity_result.action, "block_due_to_policy")
  assert.equal(result.continuity_result.severity, "block")
  assert.equal(result.continuity_result.issues_count, 1)
})
