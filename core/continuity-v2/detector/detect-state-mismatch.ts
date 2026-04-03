import type { ContinuityIssue, DraftClaim, ProjectState } from "../types"

function getStatusField(
  project: ProjectState | null,
  key: string,
): string | null {
  if (!project) return null
  const found = project.status_fields.find((field) => field.key === key)
  return found?.value ?? null
}

export function detectStateMismatch(input: {
  draftId: string
  claims: DraftClaim[]
  project: ProjectState | null
}): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []

  for (const claim of input.claims) {
    if (claim.claim_type !== "status_assertion") continue

    if (claim.key === "handoff_quality_score" && claim.value === "incomplete") {
      const approvedValue = getStatusField(input.project, "handoff_quality_score")
      if (approvedValue === "100") {
        issues.push({
          issue_id: `iss_state_${claim.claim_id}`,
          issue_type: "state_mismatch_confirmed",
          severity: "error",
          message:
            "Draft implies handoff quality is still incomplete, but approved state says score is already 100.",
          evidence: [
            {
              source_type: "draft",
              source_id: input.draftId,
              field: "normalized_text",
              value: claim.value,
            },
            {
              source_type: "approved_state",
              source_id: input.project?.state_id ?? "unknown_state",
              field: "status_fields.handoff_quality_score",
              value: approvedValue,
            },
          ],
          blocking: false,
          repairable: true,
        })
      }
    }

    if (claim.key === "evaluator_v1_complete" && claim.value === "false") {
      const approvedValue = getStatusField(input.project, "evaluator_v1_complete")
      if (approvedValue === "true") {
        issues.push({
          issue_id: `iss_state_${claim.claim_id}`,
          issue_type: "state_mismatch_confirmed",
          severity: "error",
          message:
            "Draft implies evaluator v1 is incomplete, but approved state says it is already complete.",
          evidence: [
            {
              source_type: "draft",
              source_id: input.draftId,
              field: "normalized_text",
              value: claim.value,
            },
            {
              source_type: "approved_state",
              source_id: input.project?.state_id ?? "unknown_state",
              field: "status_fields.evaluator_v1_complete",
              value: approvedValue ?? "",
            },
          ],
          blocking: false,
          repairable: true,
        })
      }
    }

    if (claim.key === "phase" && claim.value === "v1_implementation") {
      const approvedValue = input.project?.phase ?? null
      if (approvedValue && approvedValue !== "v1_implementation") {
        issues.push({
          issue_id: `iss_state_${claim.claim_id}`,
          issue_type: "state_mismatch_confirmed",
          severity: "error",
          message:
            "Draft phase assertion conflicts with the approved project phase.",
          evidence: [
            {
              source_type: "draft",
              source_id: input.draftId,
              field: "normalized_text",
              value: claim.value,
            },
            {
              source_type: "approved_state",
              source_id: input.project?.state_id ?? "unknown_state",
              field: "phase",
              value: approvedValue,
            },
          ],
          blocking: false,
          repairable: true,
        })
      }
    }
  }

  return issues
}
