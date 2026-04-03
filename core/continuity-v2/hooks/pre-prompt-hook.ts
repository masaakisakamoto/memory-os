import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import type {
  PrePromptHookInput,
  PrePromptHookOutput,
} from "./pre-prompt-hook.types"

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
    claims: unknown[]
    issues: unknown[]
    selectedBlocks: unknown[]
    decision: {
      decision_id: string
      severity: string
      action: string
      selectedInjectionBlocks: string[]
      explanationTrace: {
        trace_id: string
        decision_id: string
        entries: unknown[]
      }
      created_at: string
    }
    promptGuardResult: {
      action: string
      injected_context_text: string | null
      visible_message: string | null
      blocked_reason: string | null
    }
    ledgerEvents: unknown[]
  } | null
  error: {
    code: string
    message: string
  } | null
}

function buildDraftId(input: PrePromptHookInput): string {
  return input.draft_id ?? "hook_draft_001"
}

function runContinuityCheck(
  input: PrePromptHookInput,
): ContinuityCheckCliJsonOutput {
  const cliPath = path.join(
    process.cwd(),
    "cli",
    "continuity-check.ts",
  )

  const args = [
    cliPath,
    "--text",
    input.prompt,
    "--session-id",
    input.session_id,
    "--draft-id",
    buildDraftId(input),
    "--output",
    "json",
  ]

  if (input.project_id !== null) {
    args.push("--project-id", input.project_id)
  }

  try {
    const stdout = execFileSync("tsx", args, {
      encoding: "utf-8",
      env: process.env,
    })

    return JSON.parse(stdout) as ContinuityCheckCliJsonOutput
  } catch (error: unknown) {
    const maybeError = error as {
      stdout?: string | Buffer
    }

    if (maybeError?.stdout) {
      const stdout =
        typeof maybeError.stdout === "string"
          ? maybeError.stdout
          : maybeError.stdout.toString("utf-8")

      return JSON.parse(stdout) as ContinuityCheckCliJsonOutput
    }

    return {
      ok: false,
      input: {
        source: "text",
        input_format: "raw_text",
        project_id: input.project_id,
        session_id: input.session_id,
        draft_id: buildDraftId(input),
      },
      result: null,
      error: {
        code: "HOOK_EXECUTION_FAILED",
        message: "continuity-check execution failed",
      },
    }
  }
}

export function prePromptHook(
  input: PrePromptHookInput,
): PrePromptHookOutput {
  const cliResult = runContinuityCheck(input)

  if (!cliResult.ok || cliResult.result === null) {
    return {
      allow: false,
      mode: "block",
      message: cliResult.error?.message ?? "continuity-check execution failed",
      continuity_result: {
        action: cliResult.error?.code ?? "HOOK_EXECUTION_FAILED",
        severity: "block",
        issues_count: 0,
      },
    }
  }

  const action = cliResult.result.promptGuardResult.action
  const severity = cliResult.result.decision.severity
  const issuesCount = cliResult.result.issues.length

  if (
    action === "allow_no_injection" ||
    action === "allow_with_silent_injection"
  ) {
    return {
      allow: true,
      mode: "pass",
      message: null,
      continuity_result: {
        action,
        severity,
        issues_count: issuesCount,
      },
    }
  }

  if (action === "allow_with_visible_suggestion") {
    return {
      allow: true,
      mode: "suggest",
      message: cliResult.result.promptGuardResult.visible_message,
      continuity_result: {
        action,
        severity,
        issues_count: issuesCount,
      },
    }
  }

  if (action === "block_due_to_policy") {
    return {
      allow: false,
      mode: "block",
      message: cliResult.result.promptGuardResult.blocked_reason,
      continuity_result: {
        action,
        severity,
        issues_count: issuesCount,
      },
    }
  }

  return {
    allow: false,
    mode: "block",
    message: "continuity-check execution failed",
    continuity_result: {
      action: "HOOK_EXECUTION_FAILED",
      severity: "block",
      issues_count: 0,
    },
  }
}
