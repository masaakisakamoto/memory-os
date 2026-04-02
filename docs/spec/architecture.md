# Memory OS — Architecture

## Overview

Memory OS is a human-centered memory infrastructure for long-term AI collaboration. It externalizes AI memory into a structured, auditable Postgres-backed store.

## Core Principles

1. **AI is stateless** — memory must be externalized between sessions
2. **Single source of truth** — Postgres canonical store, not vector index
3. **AI can READ widely, but can only PROPOSE writes** — no direct AI writes
4. **All writes go through proposal → validation → commit**
5. **Memory is time-aware** — valid_from / valid_to on every record
6. **Memory is lineage-aware** — parent/derived relationships tracked
7. **Raw logs are preserved permanently** — raw_events are immutable
8. **Context quality > memory quantity** — assembler enforces token budgets

## Data Flow

```
Raw Session File
      │
      ▼
  ingest-raw job
      │
      ├──► sessions table
      └──► raw_events table (immutable)
               │
               ▼
         extract-proposals job
               │
               ▼
         memory_proposals table
         (status: pending)
               │
               ▼
         validate-proposals job
               │
         ┌────┴────┐
         │ valid?  │
         │  yes    │ no → status: rejected
         └────┬────┘
              │
        auto-approvable? ──► yes → status: approved → commit-approved job
              │ no
              ▼
        [human review]
        POST /proposals/:id/approve
              │
              ▼
        status: approved
              │
              ▼
        commit-approved job
              │
              ├──► memory_commits table
              ├──► memories table (insert/update/supersede)
              └──► memory_lineage table
                          │
                          ▼
                  rebuild-context-cache
                          │
                          ▼
                  Handoff Context JSON
```

## Package Boundaries

| Package | Responsibility | Can Write DB? |
|---------|---------------|---------------|
| `core/memory` | extraction, classification, validation, commit logic | via committer only |
| `core/policy` | write policy enforcement, promotion rules, trust model | no |
| `core/retrieval` | read-only search and hydration | no (reads only) |
| `core/context` | context assembly and compression | no (reads only) |
| `apps/api` | REST API routing, thin orchestration | via core/memory |
| `apps/worker` | background job execution | via core/memory |
| `apps/mcp-server` | MCP protocol scaffold | propose only |
| `infra/db` | schema, migrations, seeds | DBA/migration tool only |

## Trust Level Hierarchy

```
t0_raw        — ingested raw event text
t1_extracted  — extracted by heuristic extractor
t2_validated  — passed schema + policy validation
t3_committed  — committed after human or rule approval
t4_human      — explicitly confirmed by human
t5_canonical  — promoted to canonical status (highest trust)
```

Only memories at `t2_validated` or above appear in context output.
