import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { validateProposalDoc } from '@memory-os/core-memory';
import { commitApprovedProposal } from '@memory-os/core-memory';

export async function proposalsRoute(
  app: FastifyInstance,
  opts: { db: Pool }
) {
  app.post('/proposals', async (req, reply) => {
    const body = req.body as Record<string, unknown>;

    const proposalId = `prop_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();

    const doc = {
      proposal_id: proposalId,
      created_at: now,
      ...body,
    } as Record<string, unknown> & { proposal_id: string; created_at: string };

    const validation = validateProposalDoc(doc);
    if (!validation.valid) {
      return reply.status(400).send({ error: 'Invalid proposal', details: validation.errors });
    }
    if (!validation.policy_allows) {
      return reply.status(403).send({ error: 'Policy does not allow this proposal type' });
    }

    await opts.db.query(
      `INSERT INTO memory_proposals
        (proposal_id, memory_type, operation, target_memory_id, proposed_content, reason,
         source_refs, confidence, risk_level, approval_required, proposer, conflict_candidates, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,
      [
        proposalId,
        doc['memory_type'],
        doc['operation'],
        doc['target_memory_id'] ?? null,
        doc['proposed_content'],
        doc['reason'],
        JSON.stringify(doc['source_refs'] ?? []),
        doc['confidence'] ?? null,
        doc['risk_level'] ?? 'medium',
        validation.auto_approvable ? false : true,
        doc['proposer'] ?? 'api',
        JSON.stringify(doc['conflict_candidates'] ?? []),
        now,
      ]
    );

    if (validation.auto_approvable) {
      await opts.db.query(
        `UPDATE memory_proposals SET status = 'approved' WHERE proposal_id = $1`,
        [proposalId]
      );
      const result = await commitApprovedProposal(opts.db, {
        proposal_id: proposalId,
        decided_by: 'rule_engine',
        decision_note: 'Auto-approved by write policy',
      });
      return reply.status(201).send({ proposal_id: proposalId, auto_committed: true, commit: result });
    }

    return reply.status(201).send({ proposal_id: proposalId, status: 'pending', auto_committed: false });
  });

  app.post('/proposals/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { decision_note?: string } | undefined;

    const { rows: [proposal] } = await opts.db.query(
      `SELECT * FROM memory_proposals WHERE proposal_id = $1`,
      [id]
    );

    if (!proposal) {
      return reply.status(404).send({ error: 'Proposal not found' });
    }
    if (proposal.status !== 'pending') {
      return reply.status(409).send({ error: `Proposal is already ${proposal.status}` });
    }

    await opts.db.query(
      `UPDATE memory_proposals SET status = 'approved' WHERE proposal_id = $1`,
      [id]
    );

    const result = await commitApprovedProposal(opts.db, {
      proposal_id: id,
      decided_by: 'human',
      decision_note: body?.decision_note,
    });

    return { commit: result };
  });
}
