import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { prePromptCheck } from "../../core/continuity-v2/pipeline/pre-prompt-check"
import type { ActiveContextSnapshot, PromptDraft, ProjectState } from "../../core/continuity-v2/types"

const repoRoot = process.cwd()
const fixturesDir = path.join(repoRoot, "data/fixtures/continuity-v2")

function readJson<T>(fileName: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(fixturesDir, fileName), "utf-8"),
  ) as T
}

test("pre-prompt-check: state mismatch vertical slice", () => {
  const draft = readJson<PromptDraft>("prompt-draft.valid.json")
  const project = readJson<ProjectState>("project-state.valid.json")

  const activeContext: ActiveContextSnapshot = {
    project,
    globalPolicies: [],
    projectPolicies: [],
    activeDecisions: [],
  }

  const result = prePromptCheck({
    draft,
    activeContext,
  })

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.issue_type, "state_mismatch_confirmed")
  assert.equal(result.selectedBlocks.length, 1)
  assert.equal(result.selectedBlocks[0]?.block_type, "active_state")
  assert.equal(result.decision.action, "allow_with_visible_suggestion")
  assert.equal(result.promptGuardResult.visible_message !== null, true)
  assert.equal(result.ledgerEvents.length >= 2, true)
})
