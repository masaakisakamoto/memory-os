# Memory OS — Memory Model

## Memory Types

| Type | Description | Human Required |
|------|-------------|----------------|
| `identity` | Who the user is: role, expertise, background | Yes |
| `relationship` | How AI and user collaborate, team context | Yes |
| `goal` | Long-term goals and objectives | Yes |
| `policy` | Durable rules and standards the user has set | Yes |
| `preference` | Style and approach preferences | No (conditional) |
| `project_state` | Current project status, scope, milestones | No (conditional) |
| `procedure` | Step-by-step procedures and workflows | Yes |
| `episode` | Events, sessions, completed tasks | No (auto) |
| `decision` | Explicit decisions made | Yes |
| `evidence` | Facts, data, confirmations | No (auto) |
| `artifact_reference` | Pointers to external files, URLs, repos | No (auto) |
| `handoff_summary` | Summary prepared for next session | No (auto) |

## Memory Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `memory_id` | string | Yes | Unique identifier |
| `memory_type` | enum | Yes | One of 12 types above |
| `content` | string | Yes | Full canonical content |
| `summary` | string | No | Optional short summary for context |
| `trust_level` | enum | Yes | t0_raw through t5_canonical |
| `importance_score` | number 0-1 | No | Relative importance |
| `status` | enum | Yes | active / superseded / invalidated |
| `valid_from` | datetime | No | When memory became valid |
| `valid_to` | datetime | No | When memory was superseded/invalidated |
| `project_id` | string | No | Associated project |
| `source_refs` | string[] | No | Source event references (session:event_id) |
| `lineage.parent_memory_id` | string | No | Memory this supersedes |
| `lineage.derived_from` | string[] | No | Memories this was derived from |
| `created_at` | datetime | Yes | Creation timestamp |
| `updated_at` | datetime | No | Last update timestamp |

## Memory Lifecycle

```
[proposed] → [validated] → [approved] → [committed → active]
                                              │
                                    ┌─────────┴──────────┐
                               superseded          invalidated
                             (valid_to set)       (valid_to set)
```

## Time Semantics

All memories carry `valid_from` and `valid_to`. A memory is "current" when:
- `status = 'active'`
- `valid_from <= now`
- `valid_to IS NULL OR valid_to > now`

When a memory is superseded, a new memory is created and the old one receives `valid_to = now`.
The lineage table records the parent-child relationship.
