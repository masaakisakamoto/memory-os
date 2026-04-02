/**
 * validate-proposals — validates pending proposals and flags invalid ones.
 */

import type { Pool } from 'pg';
import { validateProposalDoc } from '@memory-os/core-memory';

export async function validateProposalsJob(db: Pool): Promise<void> {
  const { rows: proposals } = await db.query(
    `SELECT * FROM memory_proposals WHERE status = 'pending'`
  );

  console.log(`Validating ${proposals.length} pending proposals...`);
  let valid = 0, invalid = 0;

  for (const proposal of proposals) {
    const doc = {
      proposal_id: proposal.proposal_id,
      memory_type: proposal.memory_type,
      operation: proposal.operation,
      proposed_content: proposal.proposed_content,
      reason: proposal.reason,
      created_at: proposal.created_at.toISOString(),
      source_refs: proposal.source_refs,
      confidence: proposal.confidence ? parseFloat(proposal.confidence) : undefined,
      risk_level: proposal.risk_level,
      approval_required: proposal.approval_required,
      proposer: proposal.proposer,
    };

    const result = validateProposalDoc(doc);

    if (!result.valid) {
      console.warn(`Proposal ${proposal.proposal_id} invalid:`, result.errors);
      await db.query(
        `UPDATE memory_proposals SET status = 'rejected' WHERE proposal_id = $1`,
        [proposal.proposal_id]
      );
      invalid++;
    } else {
      if (result.auto_approvable) {
        await db.query(
          `UPDATE memory_proposals SET status = 'approved' WHERE proposal_id = $1`,
          [proposal.proposal_id]
        );
        console.log(`Proposal ${proposal.proposal_id} auto-approved`);
      }
      valid++;
    }
  }

  console.log(`Validation complete: ${valid} valid, ${invalid} invalid`);
}
