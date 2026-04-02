/**
 * Committer — executes the commit path:
 * approved proposal → commit record → insert/update memory → supersede handling → lineage
 *
 * project_id resolution order:
 *   1. proposal.project_id (set by proposer at extraction time)
 *   2. sessions.project_id via proposal.session_id  (fallback for session-originated proposals)
 *   3. null (no project context available)
 *
 * trust_level on committed memories is always t3_committed.
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export interface CommitInput {
  proposal_id: string;
  decided_by: 'system' | 'human' | 'rule_engine';
  decision_note?: string;
}

export interface CommitResult {
  commit_id: string;
  memory_id: string;
  operation: string;
  superseded_ids: string[];
  project_id: string | null;
}

export async function commitApprovedProposal(
  db: Pool,
  input: CommitInput
): Promise<CommitResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [proposal] } = await client.query(
      `SELECT * FROM memory_proposals WHERE proposal_id = $1 AND status = 'approved'`,
      [input.proposal_id]
    );
    if (!proposal) {
      throw new Error(`Proposal ${input.proposal_id} not found or not in approved status`);
    }

    // --- project_id resolution ---
    // 1. Use proposal.project_id if present.
    // 2. Otherwise look up via linked session.
    let effectiveProjectId: string | null = proposal.project_id ?? null;
    if (!effectiveProjectId && proposal.session_id) {
      const { rows: [session] } = await client.query(
        `SELECT project_id FROM sessions WHERE session_id = $1`,
        [proposal.session_id]
      );
      effectiveProjectId = session?.project_id ?? null;
    }

    const commitId = `commit_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO memory_commits (commit_id, proposal_id, decision, decided_by, decision_note, created_at)
       VALUES ($1, $2, 'accepted', $3, $4, $5)`,
      [commitId, input.proposal_id, input.decided_by, input.decision_note ?? null, now]
    );

    await client.query(
      `UPDATE memory_proposals SET status = 'committed' WHERE proposal_id = $1`,
      [input.proposal_id]
    );

    const supersededIds: string[] = [];
    let memoryId: string;

    if (proposal.operation === 'create') {
      memoryId = `mem_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
      await client.query(
        `INSERT INTO memories (memory_id, memory_type, content, trust_level, importance_score,
          status, valid_from, project_id, source_refs, created_at)
         VALUES ($1, $2, $3, 't3_committed', $4, 'active', $5, $6, $7, $8)`,
        [
          memoryId,
          proposal.memory_type,
          proposal.proposed_content,
          proposal.confidence,
          now,
          effectiveProjectId,
          JSON.stringify(proposal.source_refs || []),
          now,
        ]
      );

      await client.query(
        `INSERT INTO memory_lineage (memory_id, parent_memory_id, derived_from, commit_id, created_at)
         VALUES ($1, NULL, NULL, $2, $3)`,
        [memoryId, commitId, now]
      );

    } else if (proposal.operation === 'supersede' && proposal.target_memory_id) {
      await client.query(
        `UPDATE memories SET status = 'superseded', valid_to = $1, updated_at = $1
         WHERE memory_id = $2`,
        [now, proposal.target_memory_id]
      );
      supersededIds.push(proposal.target_memory_id);

      memoryId = `mem_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
      await client.query(
        `INSERT INTO memories (memory_id, memory_type, content, trust_level, importance_score,
          status, valid_from, project_id, source_refs, created_at)
         VALUES ($1, $2, $3, 't3_committed', $4, 'active', $5, $6, $7, $8)`,
        [
          memoryId,
          proposal.memory_type,
          proposal.proposed_content,
          proposal.confidence,
          now,
          effectiveProjectId,
          JSON.stringify(proposal.source_refs || []),
          now,
        ]
      );

      await client.query(
        `INSERT INTO memory_lineage (memory_id, parent_memory_id, derived_from, commit_id, created_at)
         VALUES ($1, $2, $2, $3, $4)`,
        [memoryId, proposal.target_memory_id, commitId, now]
      );

    } else if (proposal.operation === 'invalidate' && proposal.target_memory_id) {
      await client.query(
        `UPDATE memories SET status = 'invalidated', valid_to = $1, updated_at = $1,
          trust_level = 't3_committed'
         WHERE memory_id = $2`,
        [now, proposal.target_memory_id]
      );
      supersededIds.push(proposal.target_memory_id);
      memoryId = proposal.target_memory_id;

    } else if (proposal.operation === 'update' && proposal.target_memory_id) {
      await client.query(
        `UPDATE memories SET content = $1, trust_level = 't3_committed', updated_at = $2
         WHERE memory_id = $3`,
        [proposal.proposed_content, now, proposal.target_memory_id]
      );
      memoryId = proposal.target_memory_id;
    } else {
      throw new Error(`Unsupported operation: ${proposal.operation}`);
    }

    await client.query('COMMIT');
    return {
      commit_id: commitId,
      memory_id: memoryId,
      operation: proposal.operation,
      superseded_ids: supersededIds,
      project_id: effectiveProjectId,
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
