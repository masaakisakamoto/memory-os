/**
 * approve-proposal — marks a pending proposal as approved via the CLI.
 *
 * This is the human-facing approval gate that sits between extraction and commit.
 * It only sets status; the actual commit is a separate job (commit-approved).
 * Auditability is preserved: the commit record captures decided_by: 'human'.
 */

import type { Pool } from 'pg';

export async function approveProposalJob(db: Pool, proposalId: string): Promise<void> {
  const { rows: [proposal] } = await db.query(
    `SELECT proposal_id, memory_type, operation, status, proposed_content
     FROM memory_proposals WHERE proposal_id = $1`,
    [proposalId]
  );

  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }

  if (proposal.status === 'approved') {
    console.log(`Proposal ${proposalId} is already approved. Run commit-approved to commit.`);
    return;
  }

  if (proposal.status !== 'pending') {
    throw new Error(
      `Proposal ${proposalId} cannot be approved — current status: ${proposal.status}`
    );
  }

  await db.query(
    `UPDATE memory_proposals SET status = 'approved' WHERE proposal_id = $1`,
    [proposalId]
  );

  console.log(`Approved: ${proposalId}`);
  console.log(`  type:      ${proposal.memory_type}`);
  console.log(`  operation: ${proposal.operation}`);
  console.log(`  content:   ${String(proposal.proposed_content).substring(0, 80)}...`);
  console.log(`Next: run worker commit-approved to write to memories table.`);
}
