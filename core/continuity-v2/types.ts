export type DetectedLanguage = "ja" | "en" | "mixed" | "unknown"

export type PromptDraft = {
  draft_id: string
  session_id: string
  project_id: string | null
  raw_text: string
  normalized_text: string
  normalization_version: "phase0.1"
  detected_language: DetectedLanguage
  created_at: string
  token_estimate: number
}

export type DraftClaimType =
  | "referential_phrase"
  | "status_assertion"
  | "policy_assertion"

export type DraftClaim = {
  claim_id: string
  draft_id: string
  claim_type: DraftClaimType
  key: string | null
  value: string
  span_start: number
  span_end: number
  extractor_rule_id: string
}

export type ProjectStatusField = {
  key: string
  value: string
}

export type ProjectState = {
  state_id: string
  project_id: string
  phase: string
  summary: string
  status_fields: ProjectStatusField[]
  approved_at: string
  source_commit_id: string
}

export type PolicyScope = "global" | "project"

export type PolicyRecord = {
  policy_id: string
  scope: PolicyScope
  project_id: string | null
  key: string
  value: string
  status: "approved"
  approved_at: string
  source_commit_id: string
}

export type DecisionRecord = {
  decision_id: string
  project_id: string
  category: string
  key: string
  value: string
  status: "approved"
  approved_at: string
  source_commit_id: string
}

export type IssueSourceType =
  | "draft"
  | "approved_state"
  | "policy"
  | "decision"

export type IssueEvidence = {
  source_type: IssueSourceType
  source_id: string
  field: string | null
  value: string
}

export type ContinuityIssueType =
  | "ambiguous_reference"
  | "state_mismatch_confirmed"
  | "policy_violation"

export type IssueSeverity = "warn" | "error" | "block"

export type ContinuityIssue = {
  issue_id: string
  issue_type: ContinuityIssueType
  severity: IssueSeverity
  message: string
  evidence: IssueEvidence[]
  blocking: boolean
  repairable: boolean
}

export type ContextBlockType =
  | "project_identity"
  | "active_state"
  | "global_policy"
  | "relevant_decision"

export type ContextBlockSourceType = "project" | "state" | "policy" | "decision"

export type ContextBlock = {
  block_id: string
  block_type: ContextBlockType
  source_id: string
  source_type: ContextBlockSourceType
  text: string
  priority: number
  token_estimate: number
  silent_allowed: boolean
  relevance_score: number
}

export type ExplanationStage =
  | "normalize"
  | "extract"
  | "detect"
  | "inject"
  | "decide"

export type ExplanationStatus = "applied" | "skipped"

export type ExplanationTraceEntry = {
  step: number
  stage: ExplanationStage
  rule_id: string
  status: ExplanationStatus
  summary: string
  related_ids: string[]
}

export type StructuredExplanationTrace = {
  trace_id: string
  decision_id: string
  entries: ExplanationTraceEntry[]
}

export type DecisionSeverity = "none" | "warn" | "error" | "block"

export type DecisionAction =
  | "allow_no_injection"
  | "allow_with_silent_injection"
  | "allow_with_visible_suggestion"
  | "block_due_to_policy"

export type DecisionResult = {
  decision_id: string
  severity: DecisionSeverity
  action: DecisionAction
  selectedInjectionBlocks: string[]
  explanationTrace: StructuredExplanationTrace
  created_at: string
}

export type PromptGuardResult = {
  action: DecisionAction
  injected_context_text: string | null
  visible_message: string | null
  blocked_reason: string | null
}

export type ContinuityLedgerEventType =
  | "prompt_checked"
  | "issue_detected"
  | "context_injected"

export type ContinuityLedgerEvent = {
  event_id: string
  event_type: ContinuityLedgerEventType
  session_id: string
  project_id: string | null
  related_ids: string[]
  payload: Record<string, unknown>
  created_at: string
}

export type ActiveContextSnapshot = {
  project: ProjectState | null
  globalPolicies: PolicyRecord[]
  projectPolicies: PolicyRecord[]
  activeDecisions: DecisionRecord[]
}

export type PrePromptCheckInput = {
  draft: PromptDraft
  activeContext: ActiveContextSnapshot
}

export type PrePromptCheckOutput = {
  claims: DraftClaim[]
  issues: ContinuityIssue[]
  selectedBlocks: ContextBlock[]
  decision: DecisionResult
  promptGuardResult: PromptGuardResult
  ledgerEvents: ContinuityLedgerEvent[]
}
