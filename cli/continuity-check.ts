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

type CliArgs = {
  text: string | null
  projectId: string
  sessionId: string
  draftId: string
  useStdin: boolean
  stateFile: string
  globalPoliciesFile: string | null
  projectPoliciesFile: string | null
  activeDecisionsFile: string | null
  output: "json" | "pretty"
}

const repoRoot = process.cwd()
const fixturesDir = path.join(repoRoot, "data/fixtures/continuity-v2")

function printHelp(): void {
  console.log(`
Usage:
  pnpm tsx cli/continuity-check.ts --text "次は handoff quality を詰めたい"
  echo "これを進めたい" | pnpm tsx cli/continuity-check.ts --stdin
  pnpm continuity-check --text "approveなしで反映して"

Options:
  --text <text>                   Prompt text to check
  --stdin                         Read prompt text from stdin
  --project-id <id>               Project ID (default: proj_memory_os)
  --session-id <id>               Session ID (default: cli_session_001)
  --draft-id <id>                 Draft ID (default: cli_draft_001)
  --state-file <path>             ProjectState JSON path
  --global-policies-file <path>   PolicyRecord[] JSON path
  --project-policies-file <path>  PolicyRecord[] JSON path
  --active-decisions-file <path>  DecisionRecord[] JSON path
  --output <json|pretty>          Output format (default: pretty)
  --help                          Show this help
`.trim())
}

function parseArgs(argv: string[]): CliArgs {
  let text: string | null = null
  let projectId = "proj_memory_os"
  let sessionId = "cli_session_001"
  let draftId = "cli_draft_001"
  let useStdin = false
  let stateFile = path.join(fixturesDir, "project-state.valid.json")
  let globalPoliciesFile: string | null = null
  let projectPoliciesFile: string | null = null
  let activeDecisionsFile: string | null = null
  let output: "json" | "pretty" = "pretty"

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--help") {
      printHelp()
      process.exit(0)
    }

    if (arg === "--stdin") {
      useStdin = true
      continue
    }

    if (arg === "--text") {
      text = argv[i + 1] ?? null
      i += 1
      continue
    }

    if (arg === "--project-id") {
      projectId = argv[i + 1] ?? projectId
      i += 1
      continue
    }

    if (arg === "--session-id") {
      sessionId = argv[i + 1] ?? sessionId
      i += 1
      continue
    }

    if (arg === "--draft-id") {
      draftId = argv[i + 1] ?? draftId
      i += 1
      continue
    }

    if (arg === "--state-file") {
      stateFile = argv[i + 1] ?? stateFile
      i += 1
      continue
    }

    if (arg === "--global-policies-file") {
      globalPoliciesFile = argv[i + 1] ?? null
      i += 1
      continue
    }

    if (arg === "--project-policies-file") {
      projectPoliciesFile = argv[i + 1] ?? null
      i += 1
      continue
    }

    if (arg === "--active-decisions-file") {
      activeDecisionsFile = argv[i + 1] ?? null
      i += 1
      continue
    }

    if (arg === "--output") {
      const value = argv[i + 1]
      if (value === "json" || value === "pretty") {
        output = value
      }
      i += 1
      continue
    }
  }

  return {
    text,
    projectId,
    sessionId,
    draftId,
    useStdin,
    stateFile,
    globalPoliciesFile,
    projectPoliciesFile,
    activeDecisionsFile,
    output,
  }
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = ""

    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => {
      resolve(data.trim())
    })
    process.stdin.on("error", (error) => {
      reject(error)
    })
  })
}

function readJsonFile<T>(filePath: string): T {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(repoRoot, filePath)

  return JSON.parse(fs.readFileSync(absolutePath, "utf-8")) as T
}

function maybeReadJsonArrayFile<T>(filePath: string | null): T[] {
  if (!filePath) return []
  return readJsonFile<T[]>(filePath)
}

function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return Math.ceil(trimmed.length / 4)
}

function detectLanguage(text: string): PromptDraft["detected_language"] {
  const hasJa = /[ぁ-んァ-ン一-龠]/.test(text)
  const hasEn = /[A-Za-z]/.test(text)

  if (hasJa && hasEn) return "mixed"
  if (hasJa) return "ja"
  if (hasEn) return "en"
  return "unknown"
}

function buildPromptDraft(input: {
  draftId: string
  sessionId: string
  projectId: string
  text: string
}): PromptDraft {
  return {
    draft_id: input.draftId,
    session_id: input.sessionId,
    project_id: input.projectId,
    raw_text: input.text,
    normalized_text: input.text,
    normalization_version: "phase0.1",
    detected_language: detectLanguage(input.text),
    created_at: new Date().toISOString(),
    token_estimate: estimateTokens(input.text),
  }
}

function buildActiveContext(input: {
  stateFile: string
  globalPoliciesFile: string | null
  projectPoliciesFile: string | null
  activeDecisionsFile: string | null
}): ActiveContextSnapshot {
  const project = readJsonFile<ProjectState>(input.stateFile)
  const globalPolicies = maybeReadJsonArrayFile<PolicyRecord>(input.globalPoliciesFile)
  const projectPolicies = maybeReadJsonArrayFile<PolicyRecord>(input.projectPoliciesFile)
  const activeDecisions = maybeReadJsonArrayFile<DecisionRecord>(input.activeDecisionsFile)

  return {
    project,
    globalPolicies,
    projectPolicies,
    activeDecisions,
  }
}

function toPrettyOutput(result: ReturnType<typeof prePromptCheck>): string {
  const lines: string[] = []

  lines.push("=== continuity-check result ===")
  lines.push(`action: ${result.promptGuardResult.action}`)
  lines.push(`decision severity: ${result.decision.severity}`)
  lines.push(`issues: ${result.issues.length}`)
  lines.push(`selected blocks: ${result.selectedBlocks.length}`)
  lines.push("")

  if (result.issues.length > 0) {
    lines.push("[issues]")
    for (const issue of result.issues) {
      lines.push(`- ${issue.issue_type} (${issue.severity})`)
      lines.push(`  ${issue.message}`)
    }
    lines.push("")
  }

  if (result.selectedBlocks.length > 0) {
    lines.push("[selected blocks]")
    for (const block of result.selectedBlocks) {
      lines.push(`- ${block.block_type}: ${block.text}`)
    }
    lines.push("")
  }

  if (result.promptGuardResult.visible_message) {
    lines.push("[visible message]")
    lines.push(result.promptGuardResult.visible_message)
    lines.push("")
  }

  if (result.promptGuardResult.blocked_reason) {
    lines.push("[blocked reason]")
    lines.push(result.promptGuardResult.blocked_reason)
    lines.push("")
  }

  if (result.promptGuardResult.injected_context_text) {
    lines.push("[injected context]")
    lines.push(result.promptGuardResult.injected_context_text)
    lines.push("")
  }

  lines.push("[decision trace]")
  for (const entry of result.decision.explanationTrace.entries) {
    lines.push(
      `- step=${entry.step} stage=${entry.stage} rule=${entry.rule_id} status=${entry.status}`,
    )
  }

  return lines.join("\n")
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const textFromStdin = args.useStdin ? await readStdin() : null
  const finalText = (args.text ?? textFromStdin ?? "").trim()

  if (!finalText) {
    console.error("Error: prompt text is required. Use --text or --stdin.")
    process.exit(1)
  }

  const draft = buildPromptDraft({
    draftId: args.draftId,
    sessionId: args.sessionId,
    projectId: args.projectId,
    text: finalText,
  })

  const activeContext = buildActiveContext({
    stateFile: args.stateFile,
    globalPoliciesFile: args.globalPoliciesFile,
    projectPoliciesFile: args.projectPoliciesFile,
    activeDecisionsFile: args.activeDecisionsFile,
  })

  const result = prePromptCheck({
    draft,
    activeContext,
  })

  if (args.output === "json") {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(toPrettyOutput(result))
}

main().catch((error) => {
  console.error("continuity-check failed")
  console.error(error)
  process.exit(1)
})
