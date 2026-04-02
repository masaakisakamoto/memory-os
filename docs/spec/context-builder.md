# Memory OS — Context Builder

## Purpose

The context builder assembles a structured handoff context from active memories.
It is the primary output consumed by the next AI session.

## Output Structure

```json
{
  "context_id": "ctx_xxx",
  "intent": "handoff",
  "role": "assistant",
  "project_id": "proj_xxx",
  "generated_at": "...",
  "sections": {
    "identity": ["..."],
    "relationship": ["..."],
    "global_policies": ["..."],
    "active_project": ["..."],
    "relevant_decisions": ["..."],
    "procedures": ["..."],
    "recent_episodes": ["..."],
    "evidence": ["..."],
    "task_frame": "..."
  },
  "token_budget": {
    "target": 2000,
    "used": 1240,
    "compression_level": "none"
  },
  "source_memories": [
    { "memory_id": "mem_xxx", "score": 0.95, "trust_level": "t3_committed" }
  ]
}
```

## Section Priority (Handoff Intent)

| Priority | Section | Memory Types |
|----------|---------|--------------|
| 1 | identity | identity |
| 2 | relationship | relationship |
| 3 | global_policies | policy |
| 4 | active_project | project_state |
| 5 | relevant_decisions | decision |
| 6 | procedures | procedure |
| 7 | recent_episodes | episode |
| 8 | evidence | evidence |
| 9 | task_frame | handoff_summary |

## Token Budget

The target token budget (default: 2000 tokens) is distributed proportionally across sections.
Token estimation: ~4 characters per token.

## Compression Levels

| Level | Trigger | Behavior |
|-------|---------|---------|
| none | used ≤ target | No truncation |
| light | used ≤ 1.3× target | Truncate items to 150 chars |
| aggressive | used > 1.3× target | Truncate to 80 chars, drop low-priority items |

## Trust Filter

Only memories with `trust_level >= t2_validated` are included in context.
Raw (t0) and extracted-only (t1) memories are excluded until validated.
