Memory OS v2 — Phase 0.3 Spec

JSON Output Schema for continuity-check
Overview

Phase 0.3 formalizes the machine-readable output of continuity-check as a JSON Schema contract.

Phase 0.2 already introduced:

- --output json
- file-based input
- deterministic error objects

Phase 0.3 does not change continuity behavior.
It adds a schema-backed output contract so other systems can rely on the CLI output in a deterministic and validated way.

This phase is about:

- output contract stability
- integration reliability
- future API/MCP readiness

This phase is not about:

- new continuity logic
- new detectors
- session linking
- repair planning
- memory mutation

---

Scope
Included
- ContinuityCheckCliJsonOutput schema definition
- success output contract
- error output contract
- deterministic output invariants
- schema validation test for CLI JSON output

Excluded
- new issue types
- new CLI behaviors
- prompt input changes
- session-linker
- repair proposals
- contradiction repair
- API/server layers

---

Goal

After Phase 0.3:

- continuity-check --output json must emit output matching a formal schema
- both success and failure outputs must validate against the schema
- the schema becomes the canonical machine-readable output contract

---

Canonical Output Type
type ContinuityCheckCliJsonOutput = {
  ok: boolean
  input: {
    source: "text" | "stdin" | "input_file"
    input_format: "raw_text" | "prompt_draft_json"
    project_id: string | null
    session_id: string
    draft_id: string
  }
  result: {
    claims: DraftClaim[]
    issues: ContinuityIssue[]
    selectedBlocks: ContextBlock[]
    decision: DecisionResult
    promptGuardResult: PromptGuardResult
    ledgerEvents: ContinuityLedgerEvent[]
  } | null
  error: {
    code:
      | "INPUT_SOURCE_CONFLICT"
      | "INPUT_SOURCE_MISSING"
      | "INPUT_FILE_READ_FAILED"
      | "INPUT_FORMAT_INVALID"
      | "PROMPT_DRAFT_INVALID"
      | "EMPTY_INPUT"
    message: string
  } | null
}

---

Output Invariants
OINV-001

If ok = true:

- result must be non-null
- error must be null

OINV-002

If ok = false:

- result must be null
- error must be non-null

OINV-003

input.source must always be present and must be one of:

- text
- stdin
- input_file

OINV-004

input.input_format must always be explicit in output, even when resolved from auto

OINV-005

decision.decision_id must equal decision.explanationTrace.decision_id

OINV-006

decision.selectedInjectionBlocks may be empty, but must always be present

OINV-007

ledgerEvents must always be an array, including when empty

OINV-008

No additional top-level properties are allowed beyond:

- ok
- input
- result
- error

---

Schema Design Boundary

The schema covers:

- top-level CLI output
- nested success result
- nested error object

The schema does not redefine the already existing contracts for:

- DraftClaim
- ContinuityIssue
- ContextBlock
- DecisionResult
- PromptGuardResult
- ContinuityLedgerEvent

Instead, it composes them.

---

Required Nested Contracts

Phase 0.3 depends on the following existing schemas:

- prompt-draft.schema.json (not directly used in output, but still part of surrounding contract set)
- continuity-issue.schema.json
- context-block.schema.json
- decision-result.schema.json
- continuity-ledger-event.schema.json

Phase 0.3 newly requires a schema for:

- prompt-guard-result.schema.json
- continuity-check-cli-output.schema.json

---

New Schema 1
prompt-guard-result.schema.json

This becomes a standalone reusable contract.

Canonical type
type PromptGuardResult = {
  action:
    | "allow_no_injection"
    | "allow_with_silent_injection"
    | "allow_with_visible_suggestion"
    | "block_due_to_policy"
  injected_context_text: string | null
  visible_message: string | null
  blocked_reason: string | null
}

Rules
PGR-001

action is required

PGR-002

All three text fields are required and nullable:

- injected_context_text
- visible_message
- blocked_reason

PGR-003

No additional properties allowed

---

New Schema 2
continuity-check-cli-output.schema.json

This is the main Phase 0.3 schema.

Top-level required properties
- ok
- input
- result
- error

Input object required properties
- source
- input_format
- project_id
- session_id
- draft_id

Success result required properties when ok = true
- claims
- issues
- selectedBlocks
- decision
- promptGuardResult
- ledgerEvents

Error object required properties when ok = false
- code
- message

---

Error Codes

The following are the only valid error codes:

INPUT_SOURCE_CONFLICT
INPUT_SOURCE_MISSING
INPUT_FILE_READ_FAILED
INPUT_FORMAT_INVALID
PROMPT_DRAFT_INVALID
EMPTY_INPUT

No other error codes are allowed in Phase 0.3.

---

JSON Schema Strategy

Use standard JSON Schema composition.

Recommended structure:

- top-level object
- oneOf for success / failure variant
- shared input definition
- shared error definition
- nested references to existing schemas

---

Recommended Success Variant Shape
{
  "ok": true,
  "input": {
    "source": "text",
    "input_format": "raw_text",
    "project_id": "proj_memory_os",
    "session_id": "cli_session_001",
    "draft_id": "cli_draft_001"
  },
  "result": {
    "claims": [],
    "issues": [],
    "selectedBlocks": [],
    "decision": {},
    "promptGuardResult": {},
    "ledgerEvents": []
  },
  "error": null
}

---

Recommended Failure Variant Shape
{
  "ok": false,
  "input": {
    "source": "text",
    "input_format": "raw_text",
    "project_id": "proj_memory_os",
    "session_id": "cli_session_001",
    "draft_id": "cli_draft_001"
  },
  "result": null,
  "error": {
    "code": "INPUT_SOURCE_CONFLICT",
    "message": "Exactly one input source must be provided."
  }
}

---

Validation Rules
VAL-001

A successful CLI JSON response must validate against:

- continuity-check-cli-output.schema.json

VAL-002

A failing CLI JSON response must validate against:

- continuity-check-cli-output.schema.json

VAL-003

Schema validation must run against actual CLI stdout JSON, not only fixtures

VAL-004

Validation must use the same Ajv-based validation strategy already used elsewhere in the repo

---

Required Tests
Test 1 — success output validation

Command:

pnpm continuity-check --text "これを進めたい" --output json

Expected:

- stdout parses as JSON
- stdout validates against continuity-check-cli-output.schema.json
- ok = true

---

Test 2 — failure output validation

Command:

pnpm continuity-check --text "x" --stdin --output json

Expected:

- exit code 1
- stdout parses as JSON
- stdout validates against continuity-check-cli-output.schema.json
- ok = false
- error.code = INPUT_SOURCE_CONFLICT

---

Test 3 — file input success validation

Command:

pnpm continuity-check --input-file ./tmp/prompt.txt --output json

Expected:

- stdout validates against schema

---

Design Constraints
DC-001

Do not change detector behavior

DC-002

Do not change decision rules

DC-003

Do not change pretty output behavior

DC-004

Do not add new error codes

DC-005

Do not weaken existing field requirements to “make tests pass”

DC-006

If current CLI JSON output fails schema validation, fix the schema or output contract mismatch explicitly

---

File Layout

Phase 0.3 should add:

core/continuity-v2/contracts/prompt-guard-result.schema.json
core/continuity-v2/contracts/continuity-check-cli-output.schema.json
evals/continuity-v2/continuity-check-cli-output-schema.test.ts

---

End-to-End Example — Success
{
  "ok": true,
  "input": {
    "source": "text",
    "input_format": "raw_text",
    "project_id": "proj_memory_os",
    "session_id": "cli_session_001",
    "draft_id": "cli_draft_001"
  },
  "result": {
    "claims": [
      {
        "claim_id": "clm_001",
        "draft_id": "cli_draft_001",
        "claim_type": "referential_phrase",
        "key": null,
        "value": "これ",
        "span_start": 0,
        "span_end": 2,
        "extractor_rule_id": "DCL-REF-001"
      }
    ],
    "issues": [
      {
        "issue_id": "iss_ambiguous_clm_001",
        "issue_type": "ambiguous_reference",
        "severity": "warn",
        "message": "Ambiguous reference detected: これ",
        "evidence": [
          {
            "source_type": "draft",
            "source_id": "cli_draft_001",
            "field": "normalized_text",
            "value": "これ"
          }
        ],
        "blocking": false,
        "repairable": false
      }
    ],
    "selectedBlocks": [],
    "decision": {
      "decision_id": "dec_001",
      "severity": "warn",
      "action": "allow_with_visible_suggestion",
      "selectedInjectionBlocks": [],
      "explanationTrace": {
        "trace_id": "trace_dec_001",
        "decision_id": "dec_001",
        "entries": [
          {
            "step": 1,
            "stage": "normalize",
            "rule_id": "NRM-PIPELINE-001",
            "status": "applied",
            "summary": "Applied normalization rule NRM-PIPELINE-001",
            "related_ids": ["cli_draft_001"]
          },
          {
            "step": 2,
            "stage": "extract",
            "rule_id": "DCL-REF-001",
            "status": "applied",
            "summary": "Extracted draft claim via DCL-REF-001",
            "related_ids": ["clm_001"]
          },
          {
            "step": 3,
            "stage": "detect",
            "rule_id": "DET-REF-001",
            "status": "applied",
            "summary": "Detected issue via DET-REF-001",
            "related_ids": ["iss_ambiguous_clm_001"]
          },
          {
            "step": 4,
            "stage": "decide",
            "rule_id": "R-003",
            "status": "applied",
            "summary": "Selected action via R-003",
            "related_ids": ["iss_ambiguous_clm_001", "dec_001"]
          }
        ]
      },
      "created_at": "2026-04-04T05:00:00.000Z"
    },
    "promptGuardResult": {
      "action": "allow_with_visible_suggestion",
      "injected_context_text": null,
      "visible_message": "参照語が曖昧です。対象を具体化してください。",
      "blocked_reason": null
    },
    "ledgerEvents": [
      {
        "event_id": "evt_prompt_checked_001",
        "event_type": "prompt_checked",
        "session_id": "cli_session_001",
        "project_id": "proj_memory_os",
        "related_ids": ["cli_draft_001", "iss_ambiguous_clm_001", "dec_001"],
        "payload": {
          "action": "allow_with_visible_suggestion",
          "severity": "warn",
          "selectedInjectionBlocks": []
        },
        "created_at": "2026-04-04T05:00:00.000Z"
      },
      {
        "event_id": "evt_iss_ambiguous_clm_001",
        "event_type": "issue_detected",
        "session_id": "cli_session_001",
        "project_id": "proj_memory_os",
        "related_ids": ["iss_ambiguous_clm_001"],
        "payload": {
          "issue_type": "ambiguous_reference",
          "severity": "warn"
        },
        "created_at": "2026-04-04T05:00:00.000Z"
      }
    ]
  },
  "error": null
}

---

End-to-End Example — Failure
{
  "ok": false,
  "input": {
    "source": "text",
    "input_format": "raw_text",
    "project_id": "proj_memory_os",
    "session_id": "cli_session_001",
    "draft_id": "cli_draft_001"
  },
  "result": null,
  "error": {
    "code": "INPUT_SOURCE_CONFLICT",
    "message": "Exactly one input source must be provided."
  }
}

---

Completion Criteria

Phase 0.3 is complete when:

- prompt-guard-result.schema.json exists
- continuity-check-cli-output.schema.json exists
- success CLI JSON output validates against schema
- failure CLI JSON output validates against schema
- no Phase 0.2 behavior changes were required beyond contract alignment

---

Design Thesis

Phase 0.1 made the continuity layer deterministic.
Phase 0.2 made it integration-ready.
Phase 0.3 makes it schema-backed as a public interface.

That is the correct next step before adding any more continuity intelligence.
