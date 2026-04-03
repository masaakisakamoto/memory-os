import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import Ajv from "ajv"
import addFormats from "ajv-formats"

type Json = Record<string, unknown>

const repoRoot = process.cwd()

const contractsDir = path.join(repoRoot, "core/continuity-v2/contracts")
const fixturesDir = path.join(repoRoot, "data/fixtures/continuity-v2")

const ajv = new Ajv({
  allErrors: true,
  strict: true
})
addFormats(ajv)

function readJson(filePath: string): Json {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Json
}

function compileSchema(schemaFileName: string) {
  const schemaPath = path.join(contractsDir, schemaFileName)
  const schema = readJson(schemaPath)
  return ajv.compile(schema)
}

function formatErrors(errors: unknown): string {
  return JSON.stringify(errors, null, 2)
}

const schemaToFixtureMap: Array<{
  schemaFile: string
  fixtureFile: string
}> = [
  {
    schemaFile: "prompt-draft.schema.json",
    fixtureFile: "prompt-draft.valid.json"
  },
  {
    schemaFile: "project-state.schema.json",
    fixtureFile: "project-state.valid.json"
  },
  {
    schemaFile: "policy-record.schema.json",
    fixtureFile: "policy-record.valid.json"
  },
  {
    schemaFile: "decision-record.schema.json",
    fixtureFile: "decision-record.valid.json"
  },
  {
    schemaFile: "continuity-issue.schema.json",
    fixtureFile: "state-mismatch.issue.json"
  },
  {
    schemaFile: "context-block.schema.json",
    fixtureFile: "active-state.block.json"
  },
  {
    schemaFile: "decision-result.schema.json",
    fixtureFile: "decision-result.visible-suggestion.json"
  },
  {
    schemaFile: "continuity-ledger-event.schema.json",
    fixtureFile: "ledger-event.prompt-checked.json"
  }
]

test("continuity-v2: all schemas exist", () => {
  for (const entry of schemaToFixtureMap) {
    const schemaPath = path.join(contractsDir, entry.schemaFile)
    assert.equal(
      fs.existsSync(schemaPath),
      true,
      `Missing schema file: ${schemaPath}`
    )
  }
})

test("continuity-v2: all fixtures exist", () => {
  for (const entry of schemaToFixtureMap) {
    const fixturePath = path.join(fixturesDir, entry.fixtureFile)
    assert.equal(
      fs.existsSync(fixturePath),
      true,
      `Missing fixture file: ${fixturePath}`
    )
  }
})

for (const entry of schemaToFixtureMap) {
  test(`continuity-v2: ${entry.fixtureFile} validates against ${entry.schemaFile}`, () => {
    const validate = compileSchema(entry.schemaFile)
    const fixturePath = path.join(fixturesDir, entry.fixtureFile)
    const fixture = readJson(fixturePath)

    const valid = validate(fixture)

    assert.equal(
      valid,
      true,
      [
        `Validation failed.`,
        `Schema: ${entry.schemaFile}`,
        `Fixture: ${entry.fixtureFile}`,
        formatErrors(validate.errors)
      ].join("\n")
    )
  })
}

test("continuity-v2: decision-result fixture has matching nested decision_id", () => {
  const fixture = readJson(
    path.join(fixturesDir, "decision-result.visible-suggestion.json")
  )

  assert.equal(typeof fixture.decision_id, "string")
  assert.equal(typeof fixture.explanationTrace, "object")
  assert.equal(fixture.explanationTrace !== null, true)

  const explanationTrace = fixture.explanationTrace as {
    decision_id?: unknown
    entries?: unknown
  }

  assert.equal(
    fixture.decision_id,
    explanationTrace.decision_id,
    "decision_result.decision_id must match explanationTrace.decision_id"
  )

  assert.equal(Array.isArray(explanationTrace.entries), true)
})

test("continuity-v2: explanationTrace steps are sequential starting at 1", () => {
  const fixture = readJson(
    path.join(fixturesDir, "decision-result.visible-suggestion.json")
  )

  const explanationTrace = fixture.explanationTrace as {
    entries: Array<{ step: number }>
  }

  const steps = explanationTrace.entries.map((entry) => entry.step)
  assert.deepEqual(steps, [1, 2, 3, 4, 5])
})

test("continuity-v2: selectedInjectionBlocks matches fixture block ids", () => {
  const decisionFixture = readJson(
    path.join(fixturesDir, "decision-result.visible-suggestion.json")
  )
  const contextBlockFixture = readJson(
    path.join(fixturesDir, "active-state.block.json")
  )

  assert.deepEqual(
    decisionFixture.selectedInjectionBlocks,
    [contextBlockFixture.block_id],
    "selectedInjectionBlocks must reference the active-state fixture block_id"
  )
})

test("continuity-v2: ledger payload action matches decision fixture action", () => {
  const ledgerFixture = readJson(
    path.join(fixturesDir, "ledger-event.prompt-checked.json")
  )
  const decisionFixture = readJson(
    path.join(fixturesDir, "decision-result.visible-suggestion.json")
  )

  const payload = ledgerFixture.payload as {
    action?: unknown
    severity?: unknown
    selectedInjectionBlocks?: unknown
  }

  assert.equal(
    payload.action,
    decisionFixture.action,
    "ledger payload.action must match decision fixture action"
  )

  assert.equal(
    payload.severity,
    decisionFixture.severity,
    "ledger payload.severity must match decision fixture severity"
  )

  assert.deepEqual(
    payload.selectedInjectionBlocks,
    decisionFixture.selectedInjectionBlocks,
    "ledger payload.selectedInjectionBlocks must match decision fixture selectedInjectionBlocks"
  )
})
