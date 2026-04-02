/**
 * Hydration — enriches memory records with lineage and artifact references.
 */

import type { Pool } from 'pg';

export interface HydratedMemory {
  memory_id: string;
  memory_type: string;
  content: string;
  summary: string | null;
  trust_level: string;
  importance_score: number | null;
  status: string;
  valid_from: string;
  valid_to: string | null;
  project_id: string | null;
  source_refs: string[];
  lineage: {
    parent_memory_id: string | null;
    derived_from: string | null;
  };
  artifacts: Array<{ artifact_id: string; artifact_type: string; uri: string; label: string | null }>;
  created_at: string;
  updated_at: string | null;
}

export async function hydrateMemory(db: Pool, memoryId: string): Promise<HydratedMemory | null> {
  const { rows: [memory] } = await db.query(
    `SELECT * FROM memories WHERE memory_id = $1`,
    [memoryId]
  );
  if (!memory) return null;

  const { rows: lineageRows } = await db.query(
    `SELECT parent_memory_id, derived_from FROM memory_lineage WHERE memory_id = $1 LIMIT 1`,
    [memoryId]
  );

  const { rows: artifactRows } = await db.query(
    `SELECT artifact_id, artifact_type, uri, label FROM artifact_references WHERE memory_id = $1`,
    [memoryId]
  );

  return {
    ...memory,
    source_refs: memory.source_refs || [],
    lineage: lineageRows[0] ?? { parent_memory_id: null, derived_from: null },
    artifacts: artifactRows,
  };
}
