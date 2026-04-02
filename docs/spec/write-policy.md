# Memory OS — Write Policy

## Principle

**AI can READ widely. AI can only PROPOSE writes.**

No AI component writes directly to the `memories` table. Every write goes through:
1. Proposal creation (`memory_proposals`)
2. Schema validation
3. Policy check
4. Human approval (or rule-engine auto-approval for safe types)
5. Commit to `memories` + lineage

## Policy Table

| Type | Can Propose | Auto-Approve | Human Required |
|------|-------------|--------------|----------------|
| identity | Yes | No | **Yes** |
| relationship | Yes | No | **Yes** |
| goal | Yes | No | **Yes** |
| policy | Yes | No | **Yes** |
| preference | Yes | Conditional (confidence ≥ 0.7) | No |
| project_state | Yes | Conditional (confidence ≥ 0.7) | No |
| procedure | Yes | No | **Yes** |
| decision | Yes | No | **Yes** |
| episode | Yes | **Yes** | No |
| evidence | Yes | **Yes** | No |
| artifact_reference | Yes | **Yes** | No |
| handoff_summary | Yes | **Yes** | No |

## Conditions for Auto-Approval

A proposal can be auto-approved when:
1. `auto_approve = true` (or conditional with confidence ≥ 0.7)
2. `human_required = false`
3. `risk_level ≠ 'high'`

All three conditions must hold. High-risk proposals always require human review.

## MCP Server Policy

Proposals submitted via the MCP server always have `approval_required = true`, regardless of type.
The MCP layer is read-only + propose-only. It never triggers auto-commit.

## Operations

| Operation | Description | Supersedes old memory? |
|-----------|-------------|----------------------|
| `create` | New memory | No |
| `update` | Modify existing content | No (same memory_id) |
| `supersede` | Replace with new record | Yes (valid_to set on old) |
| `invalidate` | Mark as no longer valid | Yes (status = invalidated) |
