import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import Ajv from "ajv"
import addFormats from "ajv-formats"

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type JsonObject = { [key: string]: JsonValue }

const repoRoot = process.cwd()
const contractsDir = path.join(repoRoot, "core/continuity-v2/contracts")

function readJson(filePath: string): JsonObject {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonObject
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "continuity-check-schema-"))
}

function writeFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8")
}

function runCliJson(args: string[], cwd: string): string {
  return execFileSync("tsx", ["cli/continuity-check.ts", ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  })
}

function runCliJsonFailure(args: string[], cwd: string): {
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

function parseJsonOutput(stdout: string): JsonObject {
  return JSON.parse(stdout) as JsonObject
}

function buildAjv() {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
  })
  addFormats(ajv)

  const promptGuardSchemaPath = path.join(
    contractsDir,
    "prompt-guard-result.schema.json",
  )
  const cliOutputSchemaPath = path.join(
    contractsDir,
    "continuity-check-cli-output.schema.json",
  )

  const promptGuardSchema = readJson(promptGuardSchemaPath)
  const cliOutputSchema = readJson(cliOutputSchemaPath)

  // $id を持つ schema は 1回だけ登録する
  ajv.addSchema(promptGuardSchema)

  const validate = ajv.compile(cliOutputSchema)

  return { ajv, validate }
}

function formatErrors(errors: unknown): string {
  return JSON.stringify(errors, null, 2)
}

test("continuity-check CLI JSON output schema: success output validates", () => {
  const { validate } = buildAjv()

  const stdout = runCliJson(
    ["--text", "これを進めたい", "--output", "json"],
    repoRoot,
  )
  const out = parseJsonOutput(stdout)

  const valid = validate(out)

  assert.equal(
    valid,
    true,
    `Success output failed schema validation:\n${formatErrors(validate.errors)}`,
  )
})

test("continuity-check CLI JSON output schema: failure output validates", () => {
  const { validate } = buildAjv()

  const result = runCliJsonFailure(
    ["--text", "x", "--stdin", "--output", "json"],
    repoRoot,
  )

  assert.equal(result.status, 1)

  const out = parseJsonOutput(result.stdout)
  const valid = validate(out)

  assert.equal(
    valid,
    true,
    `Failure output failed schema validation:\n${formatErrors(validate.errors)}`,
  )
})

test("continuity-check CLI JSON output schema: file input success output validates", () => {
  const { validate } = buildAjv()

  const tempDir = makeTempDir()
  const promptPath = path.join(tempDir, "prompt.txt")
  writeFile(promptPath, "次は handoff quality を詰めたい\n")

  const stdout = runCliJson(
    ["--input-file", promptPath, "--output", "json"],
    repoRoot,
  )
  const out = parseJsonOutput(stdout)

  const valid = validate(out)

  assert.equal(
    valid,
    true,
    `File input success output failed schema validation:\n${formatErrors(validate.errors)}`,
  )
})

test("continuity-check CLI JSON output schema: success invariant ok=true", () => {
  const stdout = runCliJson(
    ["--text", "これを進めたい", "--output", "json"],
    repoRoot,
  )
  const out = parseJsonOutput(stdout)

  assert.equal(out.ok, true)
  assert.equal(out.result !== null, true)
  assert.equal(out.error, null)
})

test("continuity-check CLI JSON output schema: failure invariant ok=false", () => {
  const result = runCliJsonFailure(
    ["--text", "x", "--stdin", "--output", "json"],
    repoRoot,
  )

  assert.equal(result.status, 1)

  const out = parseJsonOutput(result.stdout)

  assert.equal(out.ok, false)
  assert.equal(out.result, null)
  assert.equal(typeof out.error, "object")
  assert.equal(out.error !== null, true)
})

test("continuity-check CLI JSON output schema: decision_id matches explanationTrace.decision_id", () => {
  const stdout = runCliJson(
    ["--text", "これを進めたい", "--output", "json"],
    repoRoot,
  )
  const out = parseJsonOutput(stdout)

  const result = out.result as JsonObject
  assert.equal(result !== null, true)

  const decision = result.decision as JsonObject
  const explanationTrace = decision.explanationTrace as JsonObject

  assert.equal(
    decision.decision_id,
    explanationTrace.decision_id,
    "decision.decision_id must match decision.explanationTrace.decision_id",
  )
})

test("continuity-check CLI JSON output schema: failure error code is deterministic", () => {
  const result = runCliJsonFailure(
    ["--text", "x", "--stdin", "--output", "json"],
    repoRoot,
  )

  assert.equal(result.status, 1)

  const out = parseJsonOutput(result.stdout)
  const error = out.error as JsonObject

  assert.equal(error.code, "INPUT_SOURCE_CONFLICT")
  assert.equal(
    error.message,
    "Exactly one input source must be provided.",
  )
})
