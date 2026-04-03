Memory OS v2 — Phase 0.2 Spec
File-Based Input / Output Contract for continuity-check
Overview

Phase 0.2 extends the Phase 0.1 CLI entrypoint into a more stable integration surface.

The goal is not to add new continuity intelligence.
The goal is to make continuity-check easier to call from:

- scripts
- other tools
- future APIs
- future MCP/server layers

This phase adds:

- file-based input
- formal machine-readable output contract

This phase does not add:

- new detectors
- memory mutation
- session linking
- repair proposals
- cross-session automation

---

Scope
Included
- --input-file <path>
- raw text file input
- PromptDraft JSON file input
- formal JSON output contract
- deterministic input resolution rules
- deterministic output mode rules
- file I/O tests

Excluded
- new continuity issue types
- session-linker
- memory patch proposals
- repair planner expansion
- contradiction repair
- API server
- MCP integration

---

Goal

After Phase 0.2, the CLI must support both of these patterns:

Raw text file input
pnpm continuity-check --input-file ./tmp/prompt.txt

PromptDraft JSON input
pnpm continuity-check --input-file ./tmp/prompt-draft.json --input-format prompt_draft_json

And must support machine-readable output:

pnpm continuity-check --input-file ./tmp/prompt.txt --output json

---

Command Contract
Supported CLI options
--text <text>
--stdin
--input-file <path>
--input-format <auto|raw_text|prompt_draft_json>
--project-id <id>
--session-id <id>
--draft-id <id>
--state-file <path>
--global-policies-file <path>
--project-policies-file <path>
--active-decisions-file <path>
--output <pretty|json>
--help

---

Input Source Rules

Exactly one logical prompt source must be resolved.

Allowed input sources
- --text
- --stdin
- --input-file

Rule IF-001

If --text is provided, use it as the prompt source.

Rule IF-002

If --text is not provided and --stdin is set, read stdin and use it as the prompt source.

Rule IF-003

If --text is not provided, --stdin is not set, and --input-file is provided, use file input.

Rule IF-004

If multiple input sources are explicitly provided at the same time, fail with exit code 1.

Examples that must fail:

- --text + --stdin
- --text + --input-file
- --stdin + --input-file
Rule IF-005

If no input source is provided, fail with exit code 1.

---

Input Format Rules
Supported input formats
auto
raw_text
prompt_draft_json

Default:

auto

---

Rule INF-001

If --input-format raw_text, read file contents as UTF-8 text and build a PromptDraft from that text.

Rule INF-002

If --input-format prompt_draft_json, parse file contents as JSON and require it to match the PromptDraft contract.

Rule INF-003

If --input-format auto:

- if file extension is .json, attempt prompt_draft_json
- otherwise treat as raw_text

Rule INF-004

If --input-format prompt_draft_json is used without --input-file, fail with exit code 1.

Rule INF-005

If prompt_draft_json parsing fails, fail with exit code 1.

Rule INF-006

If raw_text file is empty after trim, fail with exit code 1.

---

PromptDraft Resolution Rules

Phase 0.2 keeps PromptDraft generation deterministic.

Rule PD-001

If input is raw text, build PromptDraft with:

- draft_id: CLI arg or default
- session_id: CLI arg or default
- project_id: CLI arg or default
- raw_text: file content
- normalized_text: same as raw_text before pipeline normalization
- normalization_version: "phase0.1"
- detected_language: deterministic language detection
- created_at: current ISO timestamp
- token_estimate: deterministic estimate

Rule PD-002

If input is prompt_draft_json, use the file object as PromptDraft input as-is.

Rule PD-003

If prompt_draft_json.project_id is null and CLI --project-id is provided, CLI value may override null.

Rule PD-004

If prompt_draft_json.project_id is non-null, CLI --project-id must not override it.

Rule PD-005

If required PromptDraft fields are missing, fail with exit code 1.

---

Output Mode Rules
Supported output modes
pretty
json

Default:

pretty

---

Rule OUT-001

If --output pretty, print human-readable output only.

Rule OUT-002

If --output json, print machine-readable JSON only.

Rule OUT-003

In json mode, stdout must contain only valid JSON.

Rule OUT-004

In json mode, user-facing prose, headers, separators, and debug lines are forbidden.

---

JSON Output Contract

Phase 0.2 defines continuity-check machine-readable output as a formal contract.

Type
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
Rule OINV-001

If ok = true, then:

- result must be non-null
- error must be null

Rule OINV-002

If ok = false, then:

- result must be null
- error must be non-null

Rule OINV-003

input.source must reflect the actual resolved source:

- text
- stdin
- input_file

Rule OINV-004

input.input_format must be explicit in output, even when resolved from auto.

---

Error Contract
Error codes
INPUT_SOURCE_CONFLICT
INPUT_SOURCE_MISSING
INPUT_FILE_READ_FAILED
INPUT_FORMAT_INVALID
PROMPT_DRAFT_INVALID
EMPTY_INPUT

Rule ERR-001

All CLI contract failures must return:

- exit code 1
- JSON error object in --output json
- short deterministic stderr message in --output pretty

Rule ERR-002

Error messages must be deterministic fixed strings, not free-form prose.

---

Structured Error Messages
INPUT_SOURCE_CONFLICT
Exactly one input source must be provided.

INPUT_SOURCE_MISSING
Prompt input is required.

INPUT_FILE_READ_FAILED
Failed to read input file.

INPUT_FORMAT_INVALID
Input format is invalid for the provided file.

PROMPT_DRAFT_INVALID
PromptDraft JSON is invalid.

EMPTY_INPUT
Prompt input is empty.

---

Input File Types
A. Raw text file

Example: prompt.txt

次は handoff quality を詰めたい

---

B. PromptDraft JSON file

Example: prompt-draft.json

{
  "draft_id": "draft_file_001",
  "session_id": "sess_file_001",
  "project_id": "proj_memory_os",
  "raw_text": "これを進めたい",
  "normalized_text": "これを進めたい",
  "normalization_version": "phase0.1",
  "detected_language": "ja",
  "created_at": "2026-04-04T04:00:00Z",
  "token_estimate": 5
}

---

Deterministic File Resolution Rules
Rule FR-001

--input-file path may be relative or absolute.

Rule FR-002

Relative paths are resolved from process.cwd().

Rule FR-003

Files are read as UTF-8.

Rule FR-004

No file globbing.

Rule FR-005

No directory input.

Rule FR-006

No multiple --input-file values.

---

Pretty Output Rules

Pretty output remains allowed, but is not the primary contract.

Pretty output may include:
headings
issue summaries
selected blocks
prompt guard message
decision trace summary
Pretty output must not be parsed by other systems.

---

JSON Output Rules

JSON output is the primary integration contract.

JSON output must include:
resolved input metadata
full PrePromptCheckOutput
deterministic error object on failure
JSON output must not include:
ANSI colors
extra logging
help text
separators

---

Phase 0.2 Components to Add
CLI input resolver

Responsibility:

resolve exactly one input source
resolve input format
build PromptDraft deterministically
PromptDraft JSON validator

Responsibility:

validate file-loaded PromptDraft shape before pipeline execution
JSON output renderer

Responsibility:

emit ContinuityCheckCliJsonOutput

---

No Changes to Core Continuity Logic

Phase 0.2 must not change:

detectors
decision rules
injection logic
explanation trace logic
ledger logic

This phase changes only:

CLI input contract
CLI output contract

---

Required Tests
1. raw text file input smoke test

Input:

--input-file prompt.txt

Expected:

CLI succeeds
result matches Phase 0.1 behavior

---

2. PromptDraft JSON file input smoke test

Input:

--input-file prompt-draft.json --input-format prompt_draft_json

Expected:

CLI succeeds
PromptDraft fields are respected

---

3. JSON output contract test

Input:

--text "これを進めたい" --output json

Expected:

stdout is valid JSON
ok = true
result.decision.action = allow_with_visible_suggestion

---

4. input source conflict test

Input:

--text "x" --stdin

Expected:

CLI fails
exit code 1

---

5. empty input file test

Input:

empty text file

Expected:

CLI fails
error.code = EMPTY_INPUT

---

End-to-End Example 1
Raw text file input + JSON output
Command
pnpm continuity-check --input-file ./tmp/prompt.txt --output json
File content
次は handoff quality を詰めたい
Output
{
  "ok": true,
  "input": {
    "source": "input_file",
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
        "claim_type": "status_assertion",
        "key": "handoff_quality_score",
        "value": "incomplete",
        "span_start": 3,
        "span_end": 23,
        "extractor_rule_id": "DCL-STS-001"
      }
    ],
    "issues": [
      {
        "issue_id": "iss_state_clm_001",
        "issue_type": "state_mismatch_confirmed",
        "severity": "error",
        "message": "Draft implies handoff quality is still incomplete, but approved state says score is already 100.",
        "evidence": [
          {
            "source_type": "draft",
            "source_id": "cli_draft_001",
            "field": "normalized_text",
            "value": "incomplete"
          },
          {
            "source_type": "approved_state",
            "source_id": "state_001",
            "field": "status_fields.handoff_quality_score",
            "value": "100"
          }
        ],
        "blocking": false,
        "repairable": true
      }
    ],
    "selectedBlocks": [
      {
        "block_id": "cb_active_state_001",
        "block_type": "active_state",
        "source_id": "state_001",
        "source_type": "state",
        "text": "Approved state: handoff quality is already 100/100.",
        "priority": 100,
        "token_estimate": 12,
        "silent_allowed": true,
        "relevance_score": 100
      }
    ],
    "decision": {
      "decision_id": "dec_001",
      "severity": "error",
      "action": "allow_with_visible_suggestion",
      "selectedInjectionBlocks": ["cb_active_state_001"],
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
            "rule_id": "DCL-STS-001",
            "status": "applied",
            "summary": "Extracted draft claim via DCL-STS-001",
            "related_ids": ["clm_001"]
          },
          {
            "step": 3,
            "stage": "detect",
            "rule_id": "DET-STM-001",
            "status": "applied",
            "summary": "Detected issue via DET-STM-001",
            "related_ids": ["iss_state_clm_001"]
          },
          {
            "step": 4,
            "stage": "inject",
            "rule_id": "INJ-001",
            "status": "applied",
            "summary": "Selected context block(s)",
            "related_ids": ["cb_active_state_001"]
          },
          {
            "step": 5,
            "stage": "decide",
            "rule_id": "R-002",
            "status": "applied",
            "summary": "Selected action via R-002",
            "related_ids": ["iss_state_clm_001", "cb_active_state_001", "dec_001"]
          }
        ]
      },
      "created_at": "2026-04-04T04:10:00.000Z"
    },
    "promptGuardResult": {
      "action": "allow_with_visible_suggestion",
      "injected_context_text": null,
      "visible_message": "Approved state と不一致です。handoff quality は既に 100/100 です。",
      "blocked_reason": null
    },
    "ledgerEvents": [
      {
        "event_id": "evt_prompt_checked_001",
        "event_type": "prompt_checked",
        "session_id": "cli_session_001",
        "project_id": "proj_memory_os",
        "related_ids": ["cli_draft_001", "iss_state_clm_001", "dec_001"],
        "payload": {
          "action": "allow_with_visible_suggestion",
          "severity": "error",
          "selectedInjectionBlocks": ["cb_active_state_001"]
        },
        "created_at": "2026-04-04T04:10:00.000Z"
      }
    ]
  },
  "error": null
}

---

End-to-End Example 2
Invalid input source combination
Command
pnpm continuity-check --text "これを進めたい" --stdin --output json
Output
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

Phase 0.2 is complete when:

- continuity-check supports --input-file
- raw text file input works
- PromptDraft JSON input works
- --output json is a stable contract
- CLI error outputs are deterministic
- file I/O tests pass
- no Phase 0.1 continuity behavior changes

---

Design Boundary

Phase 0.2 is complete when the CLI becomes:

callable by another system without relying on human-readable output

That is the entire purpose of this phase.
