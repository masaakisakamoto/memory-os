# Memory OS

Deterministic Continuity for AI Systems

---

## Problem

AI systems lose consistency over time.

- Decisions are forgotten  
- Completed tasks remain open  
- Contradictions appear across sessions  

Chat history is not reliable memory.

---

## Solution

Memory OS detects and repairs inconsistencies.

It verifies:

- decisions vs actions  
- committed state vs open loops  
- policies vs current context  

Then repairs mismatches deterministically.

---

## Example

### ❌ Broken state

- Decision: Authentication is deferred to v1  
- Action: Build authentication system  

→ contradiction  

---

### ❌ Broken state

- Policy: All APIs must include request_id  
- Open loop: Implement request_id  

→ stale loop  

---

### ✅ Memory OS

- detects inconsistency  
- explains the issue  
- suggests fix  
- repairs if possible  

---

## Core Model

proposal → approval → commit  

No direct AI writes.

---

## Why deterministic?

LLM-based memory is not reliable for system-level consistency.

Memory OS is:

- deterministic  
- explainable  
- reproducible  

---

## What this is

- continuity verification engine  
- repair system for AI context  

## What this is NOT

- chat history storage  
- vector database  
- RAG system  

---

## Quickstart

```bash
pnpm install
pnpm build
createdb memory_os
node infra/db/migrations/run.js

node apps/worker/dist/worker.js ingest-raw --file=data/fixtures/raw/sample-session.json

node apps/worker/dist/worker.js rebuild-context-cache --project=proj_memory_os

pnpm --filter @memory-os/evals run eval:run

node apps/worker/dist/worker.js rebuild-context-cache --repair

---

## Philosophy

- Structure first.
- Determinism over probability.
- Continuity over convenience.

---

## License

- MIT
