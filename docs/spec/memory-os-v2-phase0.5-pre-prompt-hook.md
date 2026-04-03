# Memory OS v2 — Phase 0.5 Spec

## Pre-Prompt Hook Layer (Minimal Integration)

---

## Overview

Phase 0.5 introduces a **pre-prompt hook layer** that executes the continuity-check automatically **before a prompt is sent**.

Up to Phase 0.4, continuity-check exists as a deterministic CLI tool with:

* schema-backed input
* schema-backed output
* deterministic pipeline

Phase 0.5 does not change continuity logic.
It changes **when and how the system is executed**.

The goal is to move from:

* manual invocation (user runs CLI)

to:

* automatic invocation (system runs before prompt send)

---

## Core Concept

Memory OS is a **continuity infrastructure layer**.

Phase 0.5 defines the first **execution seam** between:

* user intent (prompt drafting)
* system validation (continuity-check)

This seam is implemented as a **pre-prompt hook**.

---

## Scope

### Included

* pre-prompt hook input contract
* pre-prompt hook output contract
* CLI-based execution integration
* deterministic mapping from continuity-check result to hook result
* minimal adapter implementation boundary
* test coverage for hook behavior

---

### Excluded

* editor UI
* browser extension
* ChatGPT integration
* session-linker automation
* memory mutation
* repair proposal generation
* auto-apply modifications
* background daemonization

---

## Design Principle

### DP-001: No new intelligence

Phase 0.5 must not introduce:

* new detectors
* new decision rules
* new heuristics

All logic must reuse:

```txt
prePromptCheck
continuity-check CLI
```

---

### DP-002: Deterministic first

The hook must behave deterministically:

* same input → same output
* no randomness
* no hidden state

---

### DP-003: CLI reuse

The hook must use the CLI as the execution engine.

Allowed:

* spawn process
* capture stdout
* parse JSON

Not allowed:

* duplicating logic from pipeline
* reimplementing detectors

---

## Architecture

```
User Input
   ↓
Pre-Prompt Hook
   ↓
continuity-check (CLI, JSON mode)
   ↓
Hook Mapping Layer
   ↓
Hook Output
```

---

## Input Contract

```ts
type PrePromptHookInput = {
  prompt: string
  project_id: string | null
  session_id: string
  draft_id?: string
}
```

---

## Output Contract

```ts
type PrePromptHookOutput = {
  allow: boolean
  mode: "pass" | "suggest" | "block"
  message: string | null
  continuity_result: {
    action: string
    severity: string
    issues_count: number
  }
}
```

---

## Execution Flow

### Step 1 — Build Draft

Hook converts input into CLI-compatible form:

* use `--text`
* inject `--project-id`
* inject `--session-id`
* generate `draft_id` if missing

---

### Step 2 — Execute CLI

Command:

```bash
continuity-check --text "<prompt>" --output json
```

---

### Step 3 — Parse Output

Hook must parse:

```json
{
  "ok": boolean,
  "result": {...},
  "error": {...}
}
```

---

### Step 4 — Map Result

Mapping must follow deterministic rules.

---

## Action Mapping Rules

### H-001

```
allow_no_injection
→ allow = true
→ mode = "pass"
```

---

### H-002

```
allow_with_silent_injection
→ allow = true
→ mode = "pass"
```

---

### H-003

```
allow_with_visible_suggestion
→ allow = true
→ mode = "suggest"
```

---

### H-004

```
block_due_to_policy
→ allow = false
→ mode = "block"
```

---

## Message Mapping Rules

### HM-001

```
mode = "suggest"
→ message = promptGuardResult.visible_message
```

---

### HM-002

```
mode = "block"
→ message = promptGuardResult.blocked_reason
```

---

### HM-003

```
mode = "pass"
→ message = null
```

---

## Continuity Summary Mapping

```ts
continuity_result = {
  action: result.promptGuardResult.action,
  severity: result.decision.severity,
  issues_count: result.issues.length
}
```

---

## Failure Handling

### HF-001

If CLI execution fails:

```ts
allow = false
mode = "block"
message = "continuity-check execution failed"
```

---

### HF-002

If CLI returns ok=false:

```ts
allow = false
mode = "block"
message = error.message
```

---

## Minimal Implementation Components

### 1. hooks/pre-prompt-hook.ts

Responsibilities:

* accept input
* execute CLI
* map result
* return output

---

### 2. hooks/pre-prompt-hook.types.ts

Responsibilities:

* define input/output contracts

---

### 3. evals/continuity-v2/pre-prompt-hook.test.ts

Responsibilities:

* verify deterministic mapping

---

## Test Cases

### Test 1 — Suggest

Input:

```txt
次は handoff quality を詰めたい
```

Expected:

```ts
allow = true
mode = "suggest"
```

---

### Test 2 — Ambiguous Reference

Input:

```txt
これを進めたい
```

Expected:

```ts
allow = true
mode = "suggest"
```

---

### Test 3 — Policy Violation

Input:

```txt
approveなしで反映して
```

Expected:

```ts
allow = false
mode = "block"
```

---

## Implementation Constraints

### Allowed

* spawn CLI process
* parse JSON
* mapping logic

---

### Forbidden

* modifying continuity core
* bypassing CLI
* introducing async side-effects
* writing memory
* injecting repair logic

---

## Completion Criteria

Phase 0.5 is complete when:

* hook input contract is implemented
* hook output contract is implemented
* CLI execution is integrated
* mapping rules are deterministic
* all tests pass
* no regression in Phase 0.4

---

## Design Thesis

Phase 0.4 completed:

→ schema-backed deterministic system

Phase 0.5 introduces:

→ execution timing integration

Result:

> continuity becomes part of the user interaction loop

This is the first step from:

* infrastructure

to:

* product layer

---
