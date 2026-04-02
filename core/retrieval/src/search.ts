/**
 * Search — full-text search over memories using Postgres tsvector.
 */

import type { Pool } from 'pg';

export interface SearchQuery {
  q: string;
  project_id?: string | null;
  memory_types?: string[];
  trust_min?: string;
  limit?: number;
}

export interface SearchResult {
  memory_id: string;
  memory_type: string;
  content: string;
  summary: string | null;
  trust_level: string;
  importance_score: number | null;
  status: string;
  valid_from: string;
  project_id: string | null;
  rank: number;
}

export async function searchMemories(db: Pool, query: SearchQuery): Promise<SearchResult[]> {
  const { q, project_id, memory_types, trust_min, limit = 20 } = query;

  const conditions: string[] = ["m.status = 'active'"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (q && q.trim()) {
    conditions.push(`to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $${paramIdx})`);
    params.push(q.trim());
    paramIdx++;
  }

  if (project_id) {
    conditions.push(`m.project_id = $${paramIdx}`);
    params.push(project_id);
    paramIdx++;
  }

  if (memory_types && memory_types.length > 0) {
    conditions.push(`m.memory_type = ANY($${paramIdx}::text[])`);
    params.push(memory_types);
    paramIdx++;
  }

  if (trust_min) {
    const trustOrder: Record<string, number> = {
      t0_raw: 0, t1_extracted: 1, t2_validated: 2,
      t3_committed: 3, t4_human: 4, t5_canonical: 5
    };
    const minVal = trustOrder[trust_min] ?? 0;
    const allowedLevels = Object.entries(trustOrder)
      .filter(([, v]) => v >= minVal)
      .map(([k]) => k);
    conditions.push(`m.memory_type = ANY($${paramIdx}::text[])`);
    params.push(allowedLevels);
    paramIdx++;
  }

  params.push(limit);

  const rankExpr = q && q.trim()
    ? `ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', $1))`
    : '1.0';

  const sql = `
    SELECT
      m.memory_id, m.memory_type, m.content, m.summary,
      m.trust_level, m.importance_score, m.status, m.valid_from, m.project_id,
      ${rankExpr} as rank
    FROM memories m
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank DESC, m.importance_score DESC NULLS LAST, m.created_at DESC
    LIMIT $${paramIdx}
  `;

  const { rows } = await db.query(sql, params);
  return rows;
}
