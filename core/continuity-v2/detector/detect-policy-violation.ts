import type { ContinuityIssue, DraftClaim } from "../types"

export function detectPolicyViolation(input: {
  draftId: string
  claims: DraftClaim[]
}): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []

  for (const claim of input.claims) {
    if (claim.claim_type !== "policy_assertion") continue

    if (
      claim.key === "direct_write_requested" ||
      claim.key === "approval_bypass_requested"
    ) {
      issues.push({
        issue_id: `iss_policy_${claim.claim_id}`,
        issue_type: "policy_violation",
        severity: "block",
        message:
          "Prompt requests direct write or approval bypass, which is forbidden.",
        evidence: [
          {
            source_type: "draft",
            source_id: input.draftId,
            field: "normalized_text",
            value: claim.value,
          },
        ],
        blocking: true,
        repairable: false,
      })
    }
  }

  return issues
}
