/**
 * commit-approved — processes all approved proposals and commits them to memories.
 */

import type { Pool } from 'pg';
import { commitApprovedProposal } from '@memory-os/core-memory';

export async function commitApprovedJob(db: Pool): Promise<void> {
  const { rows: proposals } = await db.query(
    `SELECT proposal_id FROM memory_proposals WHERE status = 'approved'`
  );

  console.log(`Committing ${proposals.length} approved proposals...`);

  let committed = 0, failed = 0;
  for (const { proposal_id } of proposals) {
    try {
      const result = await commitApprovedProposal(db, {
        proposal_id,
        decided_by: 'rule_engine',
        decision_note: 'Committed by worker job',
      });
      console.log(`Committed: ${proposal_id} → memory ${result.memory_id}`);
      committed++;
    } catch (err) {
      console.error(`Failed to commit ${proposal_id}:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`Commit complete: ${committed} committed, ${failed} failed`);
}
