import type {
  ActiveContextSnapshot,
  ContinuityIssue,
  DraftClaim,
  ExplanationTraceEntry,
  PrePromptCheckInput,
  PrePromptCheckOutput,
  PromptDraft,
  StructuredExplanationTrace,
} from "../types"
import { decideAction } from "../decision/decide-action"
import { detectContinuity } from "../detector/detect-continuity"
import { planInjection } from "../injection/plan-injection"
import { appendEvent } from "../ledger/append-event"

function normalizePromptDraft(draft: PromptDraft): PromptDraft {
  const normalizedText = draft.raw_text
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")

  const detected_language: PromptDraft["detected_language"] =
    /[ぁ-んァ-ン一-龠]/.test(normalizedText) && /[A-Za-z]/.test(normalizedText)
      ? "mixed"
      : /[ぁ-んァ-ン一-龠]/.test(normalizedText)
        ? "ja"
        : /[A-Za-z]/.test(normalizedText)
          ? "en"
          : "unknown"

  return {
    ...draft,
    normalized_text: normalizedText,
    normalization_version: "phase0.1",
    detected_language,
  }
}

function extractDraftClaims(draft: PromptDraft): DraftClaim[] {
  const claims: DraftClaim[] = []
  const text = draft.normalized_text
  const detectionText = text.toLowerCase()

  const pushClaim = (
    claim: Omit<DraftClaim, "claim_id" | "draft_id">,
    index: number,
  ) => {
    claims.push({
      claim_id: `clm_${String(index + 1).padStart(3, "0")}`,
      draft_id: draft.draft_id,
      ...claim,
    })
  }

  const referentialPatterns = [
    { value: "continue this", regex: /continue this/gi, rule: "DCL-REF-007" },
    { value: "これ", regex: /これ/g, rule: "DCL-REF-001" },
    { value: "それ", regex: /それ/g, rule: "DCL-REF-002" },
    { value: "あれ", regex: /あれ/g, rule: "DCL-REF-003" },
    { value: "this", regex: /\bthis\b/gi, rule: "DCL-REF-004" },
    { value: "that", regex: /\bthat\b/gi, rule: "DCL-REF-005" },
    { value: "it", regex: /\bit\b/gi, rule: "DCL-REF-006" },
  ]

  let claimIndex = 0

  for (const pattern of referentialPatterns) {
    for (const match of text.matchAll(pattern.regex)) {
      pushClaim(
        {
          claim_type: "referential_phrase",
          key: null,
          value: pattern.value,
          span_start: match.index ?? 0,
          span_end: (match.index ?? 0) + match[0].length,
          extractor_rule_id: pattern.rule,
        },
        claimIndex++,
      )
    }
  }

  const statusRules = [
    {
      includes: [
        "handoff quality を詰め",
        "handoff quality をこれから",
        "handoff quality を改善",
        "handoff quality is incomplete",
        "need to improve handoff quality",
      ],
      key: "handoff_quality_score",
      value: "incomplete",
      rule: "DCL-STS-001",
    },
    {
      includes: [
        "evaluator v1 を作る",
        "evaluator v1 をこれから実装",
        "need to build evaluator v1",
        "evaluator v1 is not complete",
      ],
      key: "evaluator_v1_complete",
      value: "false",
      rule: "DCL-STS-002",
    },
    {
      includes: [
        "phase が v1 実装",
        "今は v1 実装フェーズ",
        "currently in v1 implementation phase",
      ],
      key: "phase",
      value: "v1_implementation",
      rule: "DCL-STS-003",
    },
  ] as const

  for (const statusRule of statusRules) {
    const found = statusRule.includes.find((phrase) =>
      detectionText.includes(phrase.toLowerCase()),
    )
    if (!found) continue

    const spanStart = detectionText.indexOf(found.toLowerCase())
    pushClaim(
      {
        claim_type: "status_assertion",
        key: statusRule.key,
        value: statusRule.value,
        span_start: spanStart,
        span_end: spanStart + found.length,
        extractor_rule_id: statusRule.rule,
      },
      claimIndex++,
    )
  }

  const policyRules = [
    {
      includes: ["直接書き換えて", "write directly"],
      key: "direct_write_requested",
      value: "true",
      rule: "DCL-POL-001",
    },
    {
      includes: [
        "approveなしで反映",
        "skip approval",
        "そのままcommitして",
        "commit it directly",
      ],
      key: "approval_bypass_requested",
      value: "true",
      rule: "DCL-POL-002",
    },
  ] as const

  for (const policyRule of policyRules) {
    const found = policyRule.includes.find((phrase) =>
      detectionText.includes(phrase.toLowerCase()),
    )
    if (!found) continue

    const spanStart = detectionText.indexOf(found.toLowerCase())
    pushClaim(
      {
        claim_type: "policy_assertion",
        key: policyRule.key,
        value: policyRule.value,
        span_start: spanStart,
        span_end: spanStart + found.length,
        extractor_rule_id: policyRule.rule,
      },
      claimIndex++,
    )
  }

  return claims
}

function buildExplanationTrace(input: {
  draft: PromptDraft
  claims: DraftClaim[]
  issues: ContinuityIssue[]
  selectedBlockIds: string[]
  decisionId: string
  decisionRuleId: string
}): StructuredExplanationTrace {
  const entries: ExplanationTraceEntry[] = []
  let step = 1

  entries.push({
    step: step++,
    stage: "normalize",
    rule_id: "NRM-PIPELINE-001",
    status: "applied",
    summary: "Applied normalization rule NRM-PIPELINE-001",
    related_ids: [input.draft.draft_id],
  })

  if (input.claims.length > 0) {
    for (const claim of input.claims) {
      entries.push({
        step: step++,
        stage: "extract",
        rule_id: claim.extractor_rule_id,
        status: "applied",
        summary: `Extracted draft claim via ${claim.extractor_rule_id}`,
        related_ids: [claim.claim_id],
      })
    }
  }

  if (input.issues.length > 0) {
    for (const issue of input.issues) {
      const ruleId =
        issue.issue_type === "policy_violation"
          ? "DET-POL-001"
          : issue.issue_type === "state_mismatch_confirmed"
            ? "DET-STM-001"
            : "DET-REF-001"

      entries.push({
        step: step++,
        stage: "detect",
        rule_id: ruleId,
        status: "applied",
        summary: `Detected issue via ${ruleId}`,
        related_ids: [issue.issue_id],
      })
    }
  }

  if (input.selectedBlockIds.length > 0) {
    entries.push({
      step: step++,
      stage: "inject",
      rule_id: "INJ-001",
      status: "applied",
      summary: "Selected context block(s)",
      related_ids: input.selectedBlockIds,
    })
  }

  entries.push({
    step: step++,
    stage: "decide",
    rule_id: input.decisionRuleId,
    status: "applied",
    summary: `Selected action via ${input.decisionRuleId}`,
    related_ids: [
      ...input.issues.map((issue) => issue.issue_id),
      ...input.selectedBlockIds,
      input.decisionId,
    ],
  })

  return {
    trace_id: `trace_${input.decisionId}`,
    decision_id: input.decisionId,
    entries,
  }
}

function getDecisionRuleId(issues: ContinuityIssue[], selectedBlockIds: string[]): string {
  if (issues.some((issue) => issue.issue_type === "policy_violation")) return "R-001"
  if (issues.some((issue) => issue.issue_type === "state_mismatch_confirmed")) return "R-002"
  if (issues.some((issue) => issue.issue_type === "ambiguous_reference")) return "R-003"
  if (issues.length === 0 && selectedBlockIds.length === 0) return "R-004"
  return "R-005"
}

function buildPromptGuardResult(input: {
  issues: ContinuityIssue[]
  action: PrePromptCheckOutput["promptGuardResult"]["action"]
  injectedContextText: string | null
}): PrePromptCheckOutput["promptGuardResult"] {
  if (input.action === "block_due_to_policy") {
    return {
      action: input.action,
      injected_context_text: null,
      visible_message: null,
      blocked_reason:
        "Approved memory cannot be directly modified. Use proposal -> approval -> commit.",
    }
  }

  if (input.action === "allow_with_visible_suggestion") {
    const stateMismatch = input.issues.find(
      (issue) => issue.issue_type === "state_mismatch_confirmed",
    )

    if (stateMismatch) {
      return {
        action: input.action,
        injected_context_text: null,
        visible_message:
          "Approved state と不一致です。handoff quality は既に 100/100 です。",
        blocked_reason: null,
      }
    }

    const ambiguous = input.issues.find(
      (issue) => issue.issue_type === "ambiguous_reference",
    )

    if (ambiguous) {
      return {
        action: input.action,
        injected_context_text: null,
        visible_message: "参照語が曖昧です。対象を具体化してください。",
        blocked_reason: null,
      }
    }
  }

  if (input.action === "allow_with_silent_injection") {
    return {
      action: input.action,
      injected_context_text: input.injectedContextText,
      visible_message: null,
      blocked_reason: null,
    }
  }

  return {
    action: input.action,
    injected_context_text: null,
    visible_message: null,
    blocked_reason: null,
  }
}

export function prePromptCheck(
  input: PrePromptCheckInput,
): PrePromptCheckOutput {
  const ledgerEvents = []

  const normalizedDraft = normalizePromptDraft(input.draft)
  const claims = extractDraftClaims(normalizedDraft)
  const issues = detectContinuity({
    draftId: normalizedDraft.draft_id,
    claims,
    activeContext: input.activeContext as ActiveContextSnapshot,
  })

  const injection = planInjection({
    issues,
    activeContext: input.activeContext,
  })

  const decisionId = "dec_001"
  const decisionRuleId = getDecisionRuleId(
    issues,
    injection.selectedBlocks.map((block) => block.block_id),
  )

  const explanationTrace = buildExplanationTrace({
    draft: normalizedDraft,
    claims,
    issues,
    selectedBlockIds: injection.selectedBlocks.map((block) => block.block_id),
    decisionId,
    decisionRuleId,
  })

  const decision = decideAction({
    decisionId,
    issues,
    selectedInjectionBlocks: injection.selectedBlocks.map((block) => block.block_id),
    explanationTrace,
    createdAt: normalizedDraft.created_at,
  })

  const promptGuardResult = buildPromptGuardResult({
    issues,
    action: decision.action,
    injectedContextText: injection.injectedContextText,
  })

  const promptCheckedEvent = {
    event_id: "evt_prompt_checked_001",
    event_type: "prompt_checked" as const,
    session_id: normalizedDraft.session_id,
    project_id: normalizedDraft.project_id,
    related_ids: [
      normalizedDraft.draft_id,
      ...issues.map((issue) => issue.issue_id),
      decision.decision_id,
    ],
    payload: {
      action: decision.action,
      severity: decision.severity,
      selectedInjectionBlocks: decision.selectedInjectionBlocks,
    },
    created_at: normalizedDraft.created_at,
  }

  let nextLedgerEvents = appendEvent(ledgerEvents, promptCheckedEvent)

  for (const issue of issues) {
    nextLedgerEvents = appendEvent(nextLedgerEvents, {
      event_id: `evt_${issue.issue_id}`,
      event_type: "issue_detected",
      session_id: normalizedDraft.session_id,
      project_id: normalizedDraft.project_id,
      related_ids: [issue.issue_id],
      payload: {
        issue_type: issue.issue_type,
        severity: issue.severity,
      },
      created_at: normalizedDraft.created_at,
    })
  }

  if (injection.selectedBlocks.length > 0) {
    nextLedgerEvents = appendEvent(nextLedgerEvents, {
      event_id: "evt_context_injected_001",
      event_type: "context_injected",
      session_id: normalizedDraft.session_id,
      project_id: normalizedDraft.project_id,
      related_ids: injection.selectedBlocks.map((block) => block.block_id),
      payload: {
        block_count: injection.selectedBlocks.length,
        injected_context_text: injection.injectedContextText,
      },
      created_at: normalizedDraft.created_at,
    })
  }

  return {
    claims,
    issues,
    selectedBlocks: injection.selectedBlocks,
    decision,
    promptGuardResult,
    ledgerEvents: nextLedgerEvents,
  }
}
