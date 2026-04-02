/**
 * Lineage — reads lineage graph for a memory.
 */

import type { Pool } from 'pg';

export interface LineageNode {
  memory_id: string;
  parent_memory_id: string | null;
  derived_from: string | null;
  commit_id: string | null;
  created_at: string;
}

export async function getLineage(db: Pool, memoryId: string): Promise<LineageNode[]> {
  const { rows } = await db.query(
    `SELECT memory_id, parent_memory_id, derived_from, commit_id, created_at
     FROM memory_lineage
     WHERE memory_id = $1 OR parent_memory_id = $1
     ORDER BY created_at ASC`,
    [memoryId]
  );
  return rows;
}

export async function getAncestors(db: Pool, memoryId: string): Promise<string[]> {
  const ancestors: string[] = [];
  let current: string | null = memoryId;

  while (current) {
    const { rows }: { rows: Array<{ parent_memory_id: string | null }> } = await db.query(
      `SELECT parent_memory_id FROM memory_lineage WHERE memory_id = $1 LIMIT 1`,
      [current]
    );
    if (rows.length === 0 || !rows[0].parent_memory_id) break;
    current = rows[0].parent_memory_id;
    ancestors.push(current);
  }

  return ancestors;
}
