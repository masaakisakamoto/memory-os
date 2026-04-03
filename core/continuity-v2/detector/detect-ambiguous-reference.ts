import type { ContinuityIssue, DraftClaim } from "../types"

const REFERENTIAL_VALUES = new Set([
  "これ",
  "それ",
  "あれ",
  "this",
  "that",
  "it",
  "continue this",
])

export function detectAmbiguousReference(input: {
  draftId: string
  claims: DraftClaim[]
}): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []

  for (const claim of input.claims) {
    if (claim.claim_type !== "referential_phrase") continue
    if (!REFERENTIAL_VALUES.has(claim.value)) continue

    issues.push({
      issue_id: `iss_ambiguous_${claim.claim_id}`,
      issue_type: "ambiguous_reference",
      severity: "warn",
      message: `Ambiguous reference detected: ${claim.value}`,
      evidence: [
        {
          source_type: "draft",
          source_id: input.draftId,
          field: "normalized_text",
          value: claim.value,
        },
      ],
      blocking: false,
      repairable: false,
    })
  }

  return issues
}
