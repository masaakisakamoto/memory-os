import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { prePromptCheck } from "../core/continuity-v2/pipeline/pre-prompt-check"
import type {
  ActiveContextSnapshot,
  PolicyRecord,
  ProjectState,
  PromptDraft,
  DecisionRecord,
} from "../core/continuity-v2/types"
import Ajv from "ajv"
import addFormats from "ajv-formats"

let _promptDraftValidate: ((data: unknown) => boolean) | null = null

function getPromptDraftValidator() {
  if (_promptDraftValidate) return _promptDraftValidate

  const schemaPath = path.join(
    process.cwd(),
    "core/continuity-v2/contracts/prompt-draft.schema.json",
  )

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))

  const ajv = new Ajv({ allErrors: true, strict: true })
  addFormats(ajv)

  _promptDraftValidate = ajv.compile(schema)
  return _promptDraftValidate
}

type InputSource = "text" | "stdin" | "input_file"
type InputFormat = "raw_text" | "prompt_draft_json"
type OutputMode = "pretty" | "json"

type CliArgs = {
  text: string | null
  useStdin: boolean
  inputFile: string | null
  inputFormat: "auto" | InputFormat
  projectId: string
  sessionId: string
  draftId: string
  stateFile: string
  globalPoliciesFile: string | null
  projectPoliciesFile: string | null
  activeDecisionsFile: string | null
  output: OutputMode
}

type CliOutput = {
  ok: boolean
  input: {
    source: InputSource
    input_format: InputFormat
    project_id: string | null
    session_id: string
    draft_id: string
  }
  result: ReturnType<typeof prePromptCheck> | null
  error: {
    code: string
    message: string
  } | null
}

const repoRoot = process.cwd()
const fixturesDir = path.join(repoRoot, "data/fixtures/continuity-v2")

function fail(
  code: string,
  message: string,
  args: CliArgs,
  source: InputSource,
  format: InputFormat,
): never {
  if (args.output === "json") {
    const out: CliOutput = {
      ok: false,
      input: {
        source,
        input_format: format,
        project_id: args.projectId,
        session_id: args.sessionId,
        draft_id: args.draftId,
      },
      result: null,
      error: { code, message },
    }
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.error(message)
  }
  process.exit(1)
}

function parseArgs(argv: string[]): CliArgs {
  let text: string | null = null
  let useStdin = false
  let inputFile: string | null = null
  let inputFormat: "auto" | InputFormat = "auto"
  let projectId = "proj_memory_os"
  let sessionId = "cli_session_001"
  let draftId = "cli_draft_001"
  let stateFile = path.join(fixturesDir, "project-state.valid.json")
  let globalPoliciesFile: string | null = null
  let projectPoliciesFile: string | null = null
  let activeDecisionsFile: string | null = null
  let output: OutputMode = "pretty"

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]

    if (a === "--text") text = argv[++i]
    else if (a === "--stdin") useStdin = true
    else if (a === "--input-file") inputFile = argv[++i]
    else if (a === "--input-format") inputFormat = argv[++i] as "auto" | InputFormat
    else if (a === "--project-id") projectId = argv[++i]
    else if (a === "--session-id") sessionId = argv[++i]
    else if (a === "--draft-id") draftId = argv[++i]
    else if (a === "--state-file") stateFile = argv[++i]
    else if (a === "--global-policies-file") globalPoliciesFile = argv[++i]
    else if (a === "--project-policies-file") projectPoliciesFile = argv[++i]
    else if (a === "--active-decisions-file") activeDecisionsFile = argv[++i]
    else if (a === "--output") output = argv[++i] as OutputMode
  }

  return {
    text,
    useStdin,
    inputFile,
    inputFormat,
    projectId,
    sessionId,
    draftId,
    stateFile,
    globalPoliciesFile,
    projectPoliciesFile,
    activeDecisionsFile,
    output,
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.on("data", (c) => (data += c))
    process.stdin.on("end", () => resolve(data.trim()))
  })
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8"))
}

function detectFormat(file: string, mode: string): InputFormat {
  if (mode === "raw_text") return "raw_text"
  if (mode === "prompt_draft_json") return "prompt_draft_json"
  return file.endsWith(".json") ? "prompt_draft_json" : "raw_text"
}

function detectLanguage(text: string): PromptDraft["detected_language"] {
  const hasJa = /[ぁ-んァ-ン一-龠]/.test(text)
  const hasEn = /[A-Za-z]/.test(text)

  if (hasJa && hasEn) return "mixed"
  if (hasJa) return "ja"
  if (hasEn) return "en"
  return "unknown"
}

function buildDraft(text: string, args: CliArgs): PromptDraft {
  return {
    draft_id: args.draftId,
    session_id: args.sessionId,
    project_id: args.projectId,
    raw_text: text,
    normalized_text: text,
    normalization_version: "phase0.1",
    detected_language: detectLanguage(text),
    created_at: new Date().toISOString(),
    token_estimate: Math.ceil(text.length / 4),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const sources = [
    args.text ? 1 : 0,
    args.useStdin ? 1 : 0,
    args.inputFile ? 1 : 0,
  ].reduce((a, b) => a + b, 0)

  if (sources === 0) {
    fail(
      "INPUT_SOURCE_MISSING",
      "Prompt input is required.",
      args,
      "text",
      "raw_text",
    )
  }

  if (sources > 1) {
    fail(
      "INPUT_SOURCE_CONFLICT",
      "Exactly one input source must be provided.",
      args,
      "text",
      "raw_text",
    )
  }

  let text = ""
  let source: InputSource = "text"
  let format: InputFormat = "raw_text"

  if (args.text) {
    text = args.text
    source = "text"
    format = "raw_text"
  } else if (args.useStdin) {
    text = await readStdin()
    source = "stdin"
    format = "raw_text"
  } else if (args.inputFile) {
    source = "input_file"
    const abs = path.isAbsolute(args.inputFile)
      ? args.inputFile
      : path.join(repoRoot, args.inputFile)

    if (!fs.existsSync(abs)) {
      fail(
        "INPUT_FILE_READ_FAILED",
        "Failed to read input file.",
        args,
        source,
        format,
      )
    }

    format = detectFormat(abs, args.inputFormat)

    if (format === "raw_text") {
      text = fs.readFileSync(abs, "utf-8").trim()
    } else {
      let parsed: PromptDraft

      try {
        parsed = readJson<PromptDraft>(abs)
      } catch {
        fail(
          "INPUT_FORMAT_INVALID",
          "Input format is invalid for the provided file.",
          args,
          source,
          format,
        )
      }

      const validate = getPromptDraftValidator()
      const valid = validate(parsed)

      if (!valid) {
        fail(
          "PROMPT_DRAFT_INVALID",
          "PromptDraft JSON is invalid.",
          args,
          source,
          format,
        )
      }

      if (parsed.project_id === null && args.projectId) {
        parsed = {
          ...parsed,
          project_id: args.projectId,
        }
      }

      const ctx = buildContext(args)
      const result = prePromptCheck({ draft: parsed, activeContext: ctx })
      return output(result, args, source, format, parsed)
    }
  }

  if (!text) {
    fail(
      "EMPTY_INPUT",
      "Prompt input is empty.",
      args,
      source,
      format,
    )
  }

  const draft = buildDraft(text, args)
  const ctx = buildContext(args)
  const result = prePromptCheck({ draft, activeContext: ctx })

  output(result, args, source, format, draft)
}

function buildContext(args: CliArgs): ActiveContextSnapshot {
  const project = readJson<ProjectState>(args.stateFile)
  const globalPolicies = args.globalPoliciesFile
    ? readJson<PolicyRecord[]>(args.globalPoliciesFile)
    : []
  const projectPolicies = args.projectPoliciesFile
    ? readJson<PolicyRecord[]>(args.projectPoliciesFile)
    : []
  const activeDecisions = args.activeDecisionsFile
    ? readJson<DecisionRecord[]>(args.activeDecisionsFile)
    : []

  return { project, globalPolicies, projectPolicies, activeDecisions }
}

function output(
  result: ReturnType<typeof prePromptCheck>,
  args: CliArgs,
  source: InputSource,
  format: InputFormat,
  draft: PromptDraft,
) {
  if (args.output === "json") {
    const out: CliOutput = {
      ok: true,
      input: {
        source,
        input_format: format,
        project_id: draft.project_id,
        session_id: draft.session_id,
        draft_id: draft.draft_id,
      },
      result,
      error: null,
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log("=== continuity-check result ===")
  console.log(`action: ${result.promptGuardResult.action}`)
  console.log(`severity: ${result.decision.severity}`)
  console.log(`issues: ${result.issues.length}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
