/**
 * MCP tool: propose_memory
 * AI can only propose — never write directly.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { validateProposalDoc } from '@memory-os/core-memory';

export async function proposeMemory(
  db: Pool,
  params: Record<string, unknown>
): Promise<{ proposal_id: string; status: string; validation: unknown }> {
  const proposalId = `prop_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const now = new Date().toISOString();

  const doc = {
    proposal_id: proposalId,
    created_at: now,
    proposer: 'mcp_server',
    ...params,
  } as Record<string, unknown> & { proposal_id: string; created_at: string; proposer: string };

  const validation = validateProposalDoc(doc);

  if (!validation.valid || !validation.policy_allows) {
    return { proposal_id: proposalId, status: 'rejected', validation };
  }

  await db.query(
    `INSERT INTO memory_proposals
      (proposal_id, memory_type, operation, target_memory_id, proposed_content, reason,
       source_refs, confidence, risk_level, approval_required, proposer, conflict_candidates, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,
    [
      proposalId,
      doc.memory_type,
      (doc as any).operation ?? 'create',
      (doc as any).target_memory_id ?? null,
      doc.proposed_content,
      doc.reason,
      JSON.stringify((doc as any).source_refs ?? []),
      (doc as any).confidence ?? null,
      (doc as any).risk_level ?? 'medium',
      true,
      'mcp_server',
      JSON.stringify((doc as any).conflict_candidates ?? []),
      now,
    ]
  );

  return { proposal_id: proposalId, status: 'pending', validation };
}
