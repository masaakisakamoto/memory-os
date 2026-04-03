Memory OS v2 — Phase 0.1 Spec
Overview

Memory OS v2 Phase 0.1 implements a deterministic pre-prompt continuity check layer.

It runs before the user sends a prompt and ensures:

- no policy violations
- no obvious state inconsistencies
- minimal ambiguity reduction
- minimal context injection when needed

This phase is intentionally constrained:

- no session linking
- no memory mutation
- no repair proposals
- no LLM dependency

---

Scope
Included
- pre-prompt continuity check
- deterministic DraftClaim extraction
- limited detectors:
    - ambiguous reference
    - state mismatch
    - policy violation
- minimal context injection
- deterministic decision engine
- structured explanation trace
- append-only continuity ledger

Excluded
- session-linker automation
- cross-session continuity
- memory patch proposals
- repair planner (beyond minimal suggestion)
- contradiction resolution loops
- semantic retrieval

---

Pipeline
PromptDraft
  → normalize
  → extract DraftClaims
  → detect issues
  → plan injection
  → decide action
  → append ledger
  → return PromptGuardResult

---

Components
1. context-observer

Reads approved memory and returns minimal active context.

Returns:

- project state
- global policies
- project policies
- active decisions

---

2. DraftClaim extractor

Deterministically extracts structured claims from normalized_text.

---

3. continuity-detector

Runs 3 detectors:

- ambiguous reference
- state mismatch
- policy violation

Outputs:

- ContinuityIssue[]

---

4. injection-planner

Selects minimal ContextBlock[].

Constraints:

- max blocks: 3
- max tokens: 300

Allowed block types:

- project_identity
- active_state
- global_policy
- relevant_decision

---

5. decision-engine

Determines final action.

Actions:

- allow_no_injection
- allow_with_silent_injection
- allow_with_visible_suggestion
- block_due_to_policy

---

6. continuity-ledger

Append-only logging.

Event types:

- prompt_checked
- issue_detected
- context_injected

---

7. pre-prompt-check pipeline

Orchestrates all components.

---

PromptDraft Contract
type PromptDraft = {
  draft_id: string
  session_id: string
  project_id: string | null
  raw_text: string
  normalized_text: string
  normalization_version: "phase0.1"
  detected_language: "ja" | "en" | "mixed" | "unknown"
  created_at: string
  token_estimate: number
}

---

Prompt Normalization Rules

Applied in order:

1. trim outer whitespace
2. normalize newlines (\r\n → \n)
3. collapse whitespace to single space
4. collapse ≥3 newlines to 2
5. Unicode normalize (NFKC)
6. normalize quotes (“” → ", ‘’ → ')
7. keep original casing (lowercase only for detection copy)

Forbidden:

- rewriting meaning
- translation
- summarization
- stemming

---

DraftClaim Contract

type DraftClaim = {
  claim_id: string
  draft_id: string
  claim_type:
    | "referential_phrase"
    | "status_assertion"
    | "policy_assertion"
  key: string | null
  value: string
  span_start: number
  span_end: number
  extractor_rule_id: string
}

---

DraftClaim Extraction Rules
Referential Phrase

Triggers:

- これ / それ / あれ
- this / that / it / continue this

Output:

claim_type = referential_phrase
key = null
value = matched string

---

Status Assertion
handoff_quality_score

Triggers:

- handoff quality を詰め
- improve handoff quality
- handoff quality is incomplete

Output:

key = "handoff_quality_score"
value = "incomplete"

---

evaluator_v1_complete

Triggers:

- evaluator v1 を作る
- need to build evaluator v1

Output:

key = "evaluator_v1_complete"
value = "false"

---

phase

Triggers:

- v1 実装フェーズ
- v1 implementation phase

Output:

key = "phase"
value = "v1_implementation"

---

Policy Assertion
direct_write_requested

Triggers:

- 直接書き換えて
- write directly

---

approval_bypass_requested

Triggers:

- approveなしで反映
- skip approval
- commit it directly

---

ContinuityIssue Contract
type ContinuityIssue = {
  issue_id: string
  issue_type:
    | "ambiguous_reference"
    | "state_mismatch_confirmed"
    | "policy_violation"
  severity: "warn" | "error" | "block"
  message: string
  evidence: IssueEvidence[]
  blocking: boolean
  repairable: boolean
}

---

Detector Rules
Ambiguous Reference

Condition:

- referential_phrase exists

Output:

issue_type = ambiguous_reference
severity = warn

---

State Mismatch

Condition:

- status_assertion conflicts with approved project state

Output:

issue_type = state_mismatch_confirmed
severity = error

---

Policy Violation

Condition:

- policy_assertion detected

Output:

issue_type = policy_violation
severity = block

---

ContextBlock Contract
type ContextBlock = {
  block_id: string
  block_type:
    | "project_identity"
    | "active_state"
    | "global_policy"
    | "relevant_decision"
  source_id: string
  source_type: "project" | "state" | "policy" | "decision"
  text: string
  priority: number
  token_estimate: number
  silent_allowed: boolean
  relevance_score: number
}

---

Injection Rules

Selection:

- max blocks = 3
- max tokens = 300
- sort:
    1. priority desc
    2. relevance desc
    3. token asc

Silent injection allowed only if:

- no issues
- within limits

---

Decision Rules
R-001

policy_violation → block_due_to_policy

---

R-002

state_mismatch_confirmed → allow_with_visible_suggestion

---

R-003

ambiguous_reference → allow_with_visible_suggestion

---

R-004

no issues + no blocks → allow_no_injection

---

R-005

no issues + blocks → allow_with_silent_injection

---

DecisionResult Contract
type DecisionResult = {
  decision_id: string
  severity: "none" | "warn" | "error" | "block"
  action:
    | "allow_no_injection"
    | "allow_with_silent_injection"
    | "allow_with_visible_suggestion"
    | "block_due_to_policy"
  selectedInjectionBlocks: string[]
  explanationTrace: StructuredExplanationTrace
  created_at: string
}

---

StructuredExplanationTrace Contract
type ExplanationTraceEntry = {
  step: number
  stage: "normalize" | "extract" | "detect" | "inject" | "decide"
  rule_id: string
  status: "applied" | "skipped"
  summary: string
  related_ids: string[]
}

type StructuredExplanationTrace = {
  trace_id: string
  decision_id: string
  entries: ExplanationTraceEntry[]
}

---

Explanation Rules

Stages order:

1. normalize
2. extract
3. detect
4. inject
5. decide

Summary must be one of:

- Applied normalization rule {rule_id}
- Extracted draft claim via {rule_id}
- Detected issue via {rule_id}
- Selected context block(s)
- Selected action via {rule_id}

---

PromptGuardResult
type PromptGuardResult = {
  action: DecisionResult["action"]
  injected_context_text: string | null
  visible_message: string | null
  blocked_reason: string | null
}

---

ContinuityLedgerEvent
type ContinuityLedgerEvent = {
  event_id: string
  event_type:
    | "prompt_checked"
    | "issue_detected"
    | "context_injected"
  session_id: string
  project_id: string | null
  related_ids: string[]
  payload: Record<string, unknown>
  created_at: string
}

---

End-to-End Example

Input
次は handoff quality を詰めたい

Approved State
handoff_quality_score = 100

---

Output
Issue
state_mismatch_confirmed

---

Injection
"Approved state: handoff quality is already 100/100."

---

Decision
action = allow_with_visible_suggestion

---

PromptGuardResult
{
  "action": "allow_with_visible_suggestion",
  "injected_context_text": null,
  "visible_message": "Approved state と不一致です。handoff quality は既に 100/100 です。",
  "blocked_reason": null
}

---

Completion Criteria

Phase 0.1 is complete when:

- all schemas validate
- DraftClaim extraction is deterministic
- detectors produce expected issues
- decision rules produce correct action
- one end-to-end test passes
