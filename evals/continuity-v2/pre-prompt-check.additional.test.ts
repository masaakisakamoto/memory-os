import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { prePromptCheck } from "../../core/continuity-v2/pipeline/pre-prompt-check"
import type {
  ActiveContextSnapshot,
  PromptDraft,
  ProjectState,
} from "../../core/continuity-v2/types"

const repoRoot = process.cwd()
const fixturesDir = path.join(repoRoot, "data/fixtures/continuity-v2")

function readJson<T>(fileName: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(fixturesDir, fileName), "utf-8"),
  ) as T
}

function buildActiveContext(project: ProjectState): ActiveContextSnapshot {
  return {
    project,
    globalPolicies: [],
    projectPolicies: [],
    activeDecisions: [],
  }
}

test("pre-prompt-check: ambiguous reference returns visible suggestion without block", () => {
  const baseDraft = readJson<PromptDraft>("prompt-draft.valid.json")
  const project = readJson<ProjectState>("project-state.valid.json")

  const draft: PromptDraft = {
    ...baseDraft,
    draft_id: "draft_ambiguous_001",
    raw_text: "これを進めたい",
    normalized_text: "これを進めたい",
    detected_language: "ja",
    created_at: "2026-04-04T03:10:00Z",
  }

  const result = prePromptCheck({
    draft,
    activeContext: buildActiveContext(project),
  })

  assert.equal(result.claims.length >= 1, true)
  assert.equal(
    result.claims.some(
      (claim) =>
        claim.claim_type === "referential_phrase" && claim.value === "これ",
    ),
    true,
  )

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.issue_type, "ambiguous_reference")
  assert.equal(result.issues[0]?.severity, "warn")

  assert.equal(result.selectedBlocks.length, 0)

  assert.equal(result.decision.severity, "warn")
  assert.equal(result.decision.action, "allow_with_visible_suggestion")

  assert.equal(result.promptGuardResult.action, "allow_with_visible_suggestion")
  assert.equal(result.promptGuardResult.injected_context_text, null)
  assert.equal(result.promptGuardResult.blocked_reason, null)
  assert.equal(
    result.promptGuardResult.visible_message,
    "参照語が曖昧です。対象を具体化してください。",
  )

  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "prompt_checked"),
    true,
  )
  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "issue_detected"),
    true,
  )
  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "context_injected"),
    false,
  )
})

test("pre-prompt-check: policy violation returns block_due_to_policy", () => {
  const baseDraft = readJson<PromptDraft>("prompt-draft.valid.json")
  const project = readJson<ProjectState>("project-state.valid.json")

  const draft: PromptDraft = {
    ...baseDraft,
    draft_id: "draft_policy_001",
    raw_text: "approveなしで反映して",
    normalized_text: "approveなしで反映して",
    detected_language: "mixed",
    created_at: "2026-04-04T03:20:00Z",
  }

  const result = prePromptCheck({
    draft,
    activeContext: buildActiveContext(project),
  })

  assert.equal(result.claims.length >= 1, true)
  assert.equal(
    result.claims.some(
      (claim) =>
        claim.claim_type === "policy_assertion" &&
        claim.key === "approval_bypass_requested" &&
        claim.value === "true",
    ),
    true,
  )

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.issue_type, "policy_violation")
  assert.equal(result.issues[0]?.severity, "block")
  assert.equal(result.issues[0]?.blocking, true)

  assert.equal(result.selectedBlocks.length, 0)

  assert.equal(result.decision.severity, "block")
  assert.equal(result.decision.action, "block_due_to_policy")

  assert.equal(result.promptGuardResult.action, "block_due_to_policy")
  assert.equal(result.promptGuardResult.injected_context_text, null)
  assert.equal(result.promptGuardResult.visible_message, null)
  assert.equal(
    result.promptGuardResult.blocked_reason,
    "Approved memory cannot be directly modified. Use proposal -> approval -> commit.",
  )

  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "prompt_checked"),
    true,
  )
  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "issue_detected"),
    true,
  )
  assert.equal(
    result.ledgerEvents.some((event) => event.event_type === "context_injected"),
    false,
  )
})
