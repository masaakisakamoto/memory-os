# Memory OS — v0 Scope

## What v0 Delivers

### ✅ Included

| Feature | Implementation |
|---------|---------------|
| Raw session ingest | `ingest-raw` job: sessions + raw_events |
| Heuristic proposal extraction | `extractor.ts`: regex-based, no AI API calls |
| Schema validation | AJV against proposal.schema.json + write-policy |
| Manual approval flow | `POST /proposals/:id/approve` |
| Auto-approval for safe types | episode, evidence, artifact_reference, handoff_summary |
| Commit to memories | Transactional: commit record + memory insert + lineage |
| Supersede handling | valid_to closed on old memory, new memory created |
| Lineage tracking | memory_lineage table populated on every commit |
| Handoff context builder | Assembles from memories → context.schema.json output |
| REST API | GET /health, POST /search, POST /context, GET /memories/:id, POST /proposals, POST /proposals/:id/approve |
| MCP server scaffold | search_knowledge, get_context, propose_memory (thin delegation) |
| JSON Schema definitions | memory, proposal, commit, context, write-policy, promotion-rules |
| Test suite | schema validation, raw→proposal, proposal→commit, context build |
| Fixture data | sample session, proposal, commit, handoff context |

### ❌ Not in v0

| Feature | Reason |
|---------|--------|
| UI | Out of scope |
| Vector DB / embeddings | Not required infra for v0 |
| Autonomous multi-agent flows | Risk too high without proven foundation |
| AI-powered extraction | Intentionally heuristic-only in v0 |
| Authentication / authorization | Deferred to v1 (local dev only) |
| Context cache table | worker logs context, no persistent cache yet |
| Bulk approval UI | Use REST API directly |
| Notification system | Out of scope |
| Metrics / observability | Out of scope |

## Design Choices Made in v0

1. **Heuristic extraction**: regex rules ordered by specificity, first match wins. Avoids AI API dependency.

2. **Postgres full-text search**: `tsvector`/`plainto_tsquery` for v0 search. No vector DB needed.

3. **Jaccard deduplication**: simple token overlap detection; no embeddings required.

4. **~4 chars/token approximation**: Good enough for budget planning without tokenizer dependency.

5. **MCP proposals always require human approval**: Even auto-approvable types go through human review when submitted via MCP. Keeps the trust boundary clear.

6. **No context_cache table**: v0 generates context on-demand. Cache can be added in v1 once the schema stabilizes.

## Recommended v1 Next Steps

1. Replace heuristic extractor with LLM-based extraction (structured output)
2. Add authentication to REST API
3. Add pgvector extension for semantic search
4. Add context_cache table with TTL invalidation
5. Add bulk proposal review interface
6. Promote more memories to t4_human via explicit user confirmation flow
7. Add Slack/webhook notification for pending proposals
