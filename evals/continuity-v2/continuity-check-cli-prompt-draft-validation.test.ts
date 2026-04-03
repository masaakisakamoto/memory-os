import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"

type JsonOutput = {
  ok: boolean
  input: {
    source: "text" | "stdin" | "input_file"
    input_format: "raw_text" | "prompt_draft_json"
    project_id: string | null
    session_id: string
    draft_id: string
  }
  result: {
    claims: Array<{
      claim_id: string
      draft_id: string
      claim_type: string
      key: string | null
      value: string
      span_start: number
      span_end: number
      extractor_rule_id: string
    }>
    issues: Array<{
      issue_id: string
      issue_type: string
      severity: string
      message: string
      evidence: Array<{
        source_type: string
        source_id: string
        field: string | null
        value: string
      }>
      blocking: boolean
      repairable: boolean
    }>
    selectedBlocks: Array<{
      block_id: string
      block_type: string
      source_id: string
      source_type: string
      text: string
      priority: number
      token_estimate: number
      silent_allowed: boolean
      relevance_score: number
    }>
    decision: {
      decision_id: string
      severity: string
      action: string
      selectedInjectionBlocks: string[]
      explanationTrace: {
        trace_id: string
        decision_id: string
        entries: Array<{
          step: number
          stage: string
          rule_id: string
          status: string
          summary: string
          related_ids: string[]
        }>
      }
      created_at: string
    }
    promptGuardResult: {
      action: string
      injected_context_text: string | null
      visible_message: string | null
      blocked_reason: string | null
    }
    ledgerEvents: Array<{
      event_id: string
      event_type: string
      session_id: string
      project_id: string | null
      related_ids: string[]
      payload: Record<string, unknown>
      created_at: string
    }>
  } | null
  error: {
    code: string
    message: string
  } | null
}

const repoRoot = process.cwd()

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "continuity-prompt-draft-"))
}

function writeFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8")
}

function runCli(args: string[], cwd: string): string {
  return execFileSync("tsx", ["cli/continuity-check.ts", ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  })
}

function runCliForFailure(args: string[], cwd: string): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync("tsx", ["cli/continuity-check.ts", ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  })

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function parseJsonOutput(stdout: string): JsonOutput {
  return JSON.parse(stdout) as JsonOutput
}

test("Phase 0.4: valid PromptDraft JSON input still succeeds", () => {
  const tempDir = makeTempDir()
  const promptDraftPath = path.join(tempDir, "prompt-draft.json")

  writeFile(
    promptDraftPath,
    JSON.stringify(
      {
        draft_id: "draft_file_001",
        session_id: "sess_file_001",
        project_id: "proj_memory_os",
        raw_text: "これを進めたい",
        normalized_text: "これを進めたい",
        normalization_version: "phase0.1",
        detected_language: "ja",
        created_at: "2026-04-04T04:00:00Z",
        token_estimate: 5,
      },
      null,
      2,
    ),
  )

  const stdout = runCli(
    [
      "--input-file",
      promptDraftPath,
      "--input-format",
      "prompt_draft_json",
      "--output",
      "json",
    ],
    repoRoot,
  )

  const out = parseJsonOutput(stdout)

  assert.equal(out.ok, true)
  assert.equal(out.error, null)
  assert.equal(out.input.source, "input_file")
  assert.equal(out.input.input_format, "prompt_draft_json")
  assert.equal(out.input.project_id, "proj_memory_os")
  assert.equal(out.input.session_id, "sess_file_001")
  assert.equal(out.input.draft_id, "draft_file_001")
  assert.equal(out.result !== null, true)
  assert.equal(
    out.result?.decision.action,
    "allow_with_visible_suggestion",
  )
  assert.equal(out.result?.decision.severity, "warn")
  assert.equal(out.result?.issues[0]?.issue_type, "ambiguous_reference")
})

test("Phase 0.4: invalid PromptDraft JSON fails in json mode", () => {
  const tempDir = makeTempDir()
  const invalidPromptDraftPath = path.join(tempDir, "invalid-prompt-draft.json")

  writeFile(
    invalidPromptDraftPath,
    JSON.stringify(
      {
        session_id: "sess_invalid_001",
        project_id: "proj_memory_os",
        raw_text: "これを進めたい",
        normalized_text: "これを進めたい",
        normalization_version: "phase0.1",
        detected_language: "ja",
        created_at: "2026-04-04T04:00:00Z",
        token_estimate: 5,
      },
      null,
      2,
    ),
  )

  const result = runCliForFailure(
    [
      "--input-file",
      invalidPromptDraftPath,
      "--input-format",
      "prompt_draft_json",
      "--output",
      "json",
    ],
    repoRoot,
  )

  assert.equal(result.status, 1)

  const out = parseJsonOutput(result.stdout)

  assert.equal(out.ok, false)
  assert.equal(out.result, null)
  assert.equal(out.error !== null, true)
  assert.equal(out.error?.code, "PROMPT_DRAFT_INVALID")
  assert.equal(out.error?.message, "PromptDraft JSON is invalid.")
  assert.equal(out.input.source, "input_file")
  assert.equal(out.input.input_format, "prompt_draft_json")
})

test("Phase 0.4: invalid PromptDraft JSON fails in pretty mode", () => {
  const tempDir = makeTempDir()
  const invalidPromptDraftPath = path.join(tempDir, "invalid-prompt-draft.json")

  writeFile(
    invalidPromptDraftPath,
    JSON.stringify(
      {
        session_id: "sess_invalid_001",
        project_id: "proj_memory_os",
        raw_text: "これを進めたい",
        normalized_text: "これを進めたい",
        normalization_version: "phase0.1",
        detected_language: "ja",
        created_at: "2026-04-04T04:00:00Z",
        token_estimate: 5,
      },
      null,
      2,
    ),
  )

  const result = runCliForFailure(
    [
      "--input-file",
      invalidPromptDraftPath,
      "--input-format",
      "prompt_draft_json",
    ],
    repoRoot,
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /PromptDraft JSON is invalid\./)
})

test("Phase 0.4: malformed JSON still fails as INPUT_FORMAT_INVALID", () => {
  const tempDir = makeTempDir()
  const malformedPath = path.join(tempDir, "bad-prompt-draft.json")

  writeFile(
    malformedPath,
    `{
  "draft_id": "draft_file_001",
  "session_id": "sess_file_001",
  "project_id": "proj_memory_os",
  "raw_text": "これを進めたい",
  "normalized_text": "これを進めたい",
  "normalization_version": "phase0.1",
  "detected_language": "ja",
  "created_at": "2026-04-04T04:00:00Z",
  "token_estimate": 5,`
  )

  const result = runCliForFailure(
    [
      "--input-file",
      malformedPath,
      "--input-format",
      "prompt_draft_json",
      "--output",
      "json",
    ],
    repoRoot,
  )

  assert.equal(result.status, 1)

  const out = parseJsonOutput(result.stdout)

  assert.equal(out.ok, false)
  assert.equal(out.result, null)
  assert.equal(out.error !== null, true)
  assert.equal(out.error?.code, "INPUT_FORMAT_INVALID")
  assert.equal(
    out.error?.message,
    "Input format is invalid for the provided file.",
  )
})

test("Phase 0.4: non-null project_id in PromptDraft JSON is not overridden by CLI", () => {
  const tempDir = makeTempDir()
  const promptDraftPath = path.join(tempDir, "prompt-draft.json")

  writeFile(
    promptDraftPath,
    JSON.stringify(
      {
        draft_id: "draft_file_002",
        session_id: "sess_file_002",
        project_id: "proj_from_file",
        raw_text: "これを進めたい",
        normalized_text: "これを進めたい",
        normalization_version: "phase0.1",
        detected_language: "ja",
        created_at: "2026-04-04T04:00:00Z",
        token_estimate: 5,
      },
      null,
      2,
    ),
  )

  const stdout = runCli(
    [
      "--input-file",
      promptDraftPath,
      "--input-format",
      "prompt_draft_json",
      "--project-id",
      "proj_from_cli",
      "--output",
      "json",
    ],
    repoRoot,
  )

  const out = parseJsonOutput(stdout)

  assert.equal(out.ok, true)
  assert.equal(out.input.project_id, "proj_from_file")
  assert.equal(out.input.session_id, "sess_file_002")
  assert.equal(out.input.draft_id, "draft_file_002")
})

test("Phase 0.4: null project_id in PromptDraft JSON may be filled from CLI", () => {
  const tempDir = makeTempDir()
  const promptDraftPath = path.join(tempDir, "prompt-draft-null-project.json")

  writeFile(
    promptDraftPath,
    JSON.stringify(
      {
        draft_id: "draft_file_003",
        session_id: "sess_file_003",
        project_id: null,
        raw_text: "これを進めたい",
        normalized_text: "これを進めたい",
        normalization_version: "phase0.1",
        detected_language: "ja",
        created_at: "2026-04-04T04:00:00Z",
        token_estimate: 5,
      },
      null,
      2,
    ),
  )

  const stdout = runCli(
    [
      "--input-file",
      promptDraftPath,
      "--input-format",
      "prompt_draft_json",
      "--project-id",
      "proj_from_cli",
      "--output",
      "json",
    ],
    repoRoot,
  )

  const out = parseJsonOutput(stdout)

  assert.equal(out.ok, true)
  assert.equal(out.input.project_id, "proj_from_cli")
  assert.equal(out.input.session_id, "sess_file_003")
  assert.equal(out.input.draft_id, "draft_file_003")
})
