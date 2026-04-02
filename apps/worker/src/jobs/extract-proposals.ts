/**
 * extract-proposals — reads raw events for a session and generates proposals.
 */

import type { Pool } from 'pg';
import { extractProposals } from '@memory-os/core-memory';
import type { RawEvent } from '@memory-os/core-memory';

export async function extractProposalsJob(db: Pool, sessionId?: string): Promise<void> {
  const whereClause = sessionId ? `WHERE re.session_id = $1` : '';
  const params = sessionId ? [sessionId] : [];

  const { rows: events } = await db.query<RawEvent>(
    `SELECT re.event_id, re.session_id, re.event_type, re.role, re.content,
            re.occurred_at, re.sequence_num, re.metadata
     FROM raw_events re
     ${whereClause}
     ORDER BY re.session_id, re.sequence_num`,
    params
  );

  if (events.length === 0) {
    console.log('No events found');
    return;
  }

  const bySession = new Map<string, RawEvent[]>();
  for (const evt of events) {
    const list = bySession.get(evt.session_id) ?? [];
    list.push(evt);
    bySession.set(evt.session_id, list);
  }

  let totalProposals = 0;
  for (const [sid, sessionEvents] of bySession) {
    const proposals = extractProposals(sessionEvents, sid);

    for (const p of proposals) {
      await db.query(
        `INSERT INTO memory_proposals
          (proposal_id, session_id, memory_type, operation, target_memory_id, proposed_content,
           reason, source_refs, confidence, risk_level, approval_required, proposer,
           conflict_candidates, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)
         ON CONFLICT (proposal_id) DO NOTHING`,
        [
          p.proposal_id, sid, p.memory_type, p.operation,
          p.target_memory_id, p.proposed_content, p.reason,
          JSON.stringify(p.source_refs), p.confidence, p.risk_level,
          p.approval_required, p.proposer, JSON.stringify(p.conflict_candidates),
          p.created_at,
        ]
      );
      totalProposals++;
    }
    console.log(`Session ${sid}: ${proposals.length} proposals generated`);
  }

  console.log(`Total proposals: ${totalProposals}`);
}
