import type {
  ContinuityIssue,
  DecisionAction,
  DecisionResult,
  StructuredExplanationTrace,
} from "../types"

export function decideAction(input: {
  decisionId: string
  issues: ContinuityIssue[]
  selectedInjectionBlocks: string[]
  explanationTrace: StructuredExplanationTrace
  createdAt: string
}): DecisionResult {
  const hasPolicyViolation = input.issues.some(
    (issue) => issue.issue_type === "policy_violation",
  )
  const hasStateMismatch = input.issues.some(
    (issue) => issue.issue_type === "state_mismatch_confirmed",
  )
  const hasAmbiguousReference = input.issues.some(
    (issue) => issue.issue_type === "ambiguous_reference",
  )

  let severity: DecisionResult["severity"] = "none"
  let action: DecisionAction = "allow_no_injection"

  if (hasPolicyViolation) {
    severity = "block"
    action = "block_due_to_policy"
  } else if (hasStateMismatch) {
    severity = "error"
    action = "allow_with_visible_suggestion"
  } else if (hasAmbiguousReference) {
    severity = "warn"
    action = "allow_with_visible_suggestion"
  } else if (input.selectedInjectionBlocks.length > 0) {
    severity = "none"
    action = "allow_with_silent_injection"
  }

  return {
    decision_id: input.decisionId,
    severity,
    action,
    selectedInjectionBlocks: input.selectedInjectionBlocks,
    explanationTrace: input.explanationTrace,
    created_at: input.createdAt,
  }
}
