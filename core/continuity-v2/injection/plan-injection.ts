import type { ActiveContextSnapshot, ContextBlock, ContinuityIssue } from "../types"

export type PlanInjectionOutput = {
  selectedBlocks: ContextBlock[]
  injectedContextText: string | null
}

function buildActiveStateBlock(
  activeContext: ActiveContextSnapshot,
): ContextBlock | null {
  const project = activeContext.project
  if (!project) return null

  const handoff = project.status_fields.find(
    (field) => field.key === "handoff_quality_score",
  )?.value

  const text =
    handoff === "100"
      ? "Approved state: handoff quality is already 100/100."
      : `Approved state: project phase is ${project.phase}.`

  return {
    block_id: "cb_active_state_001",
    block_type: "active_state",
    source_id: project.state_id,
    source_type: "state",
    text,
    priority: 100,
    token_estimate: 12,
    silent_allowed: true,
    relevance_score: 100,
  }
}

export function planInjection(input: {
  issues: ContinuityIssue[]
  activeContext: ActiveContextSnapshot
}): PlanInjectionOutput {
  const hasStateMismatch = input.issues.some(
    (issue) => issue.issue_type === "state_mismatch_confirmed",
  )

  if (!hasStateMismatch) {
    return {
      selectedBlocks: [],
      injectedContextText: null,
    }
  }

  const activeStateBlock = buildActiveStateBlock(input.activeContext)
  if (!activeStateBlock) {
    return {
      selectedBlocks: [],
      injectedContextText: null,
    }
  }

  return {
    selectedBlocks: [activeStateBlock],
    injectedContextText: activeStateBlock.text,
  }
}
