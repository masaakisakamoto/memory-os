import type { ActiveContextSnapshot, ContinuityIssue, DraftClaim } from "../types"
import { detectAmbiguousReference } from "./detect-ambiguous-reference"
import { detectPolicyViolation } from "./detect-policy-violation"
import { detectStateMismatch } from "./detect-state-mismatch"

export type DetectContinuityInput = {
  draftId: string
  claims: DraftClaim[]
  activeContext: ActiveContextSnapshot
}

export function detectContinuity(
  input: DetectContinuityInput,
): ContinuityIssue[] {
  return [
    ...detectPolicyViolation({
      draftId: input.draftId,
      claims: input.claims,
    }),
    ...detectStateMismatch({
      draftId: input.draftId,
      claims: input.claims,
      project: input.activeContext.project,
    }),
    ...detectAmbiguousReference({
      draftId: input.draftId,
      claims: input.claims,
    }),
  ]
}
