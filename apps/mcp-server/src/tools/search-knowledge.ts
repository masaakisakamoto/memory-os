/**
 * MCP tool: search_knowledge
 */

import type { Pool } from 'pg';
import { searchMemories } from '@memory-os/core-retrieval';
import { rerankMemories } from '@memory-os/core-retrieval';

export async function searchKnowledge(
  db: Pool,
  params: Record<string, unknown>
): Promise<{ results: unknown[]; count: number }> {
  const q = typeof params.q === 'string' ? params.q : '';
  const project_id = typeof params.project_id === 'string' ? params.project_id : undefined;
  const limit = typeof params.limit === 'number' ? params.limit : 10;

  const results = await searchMemories(db, { q, project_id, limit });
  const reranked = rerankMemories(results as any);

  return { results: reranked, count: reranked.length };
}
