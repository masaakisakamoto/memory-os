/**
 * Assembler — fetches memories per section and assembles context sections.
 *
 * Processing order:
 *   1. Sections are sorted by priority (ascending) so high-priority sections
 *      claim memories before lower-priority ones.
 *   2. Memories already used in a higher-priority section are excluded from
 *      subsequent sections (deduplication via usedMemoryIds).
 *   3. Sections with memory_types: [] are skipped (synthesized elsewhere).
 *   4. When a primary query returns no rows and fallback_memory_types is set,
 *      a second query is run with the fallback types, using an inclusive
 *      project_id filter: (project_id = $x OR project_id IS NULL).
 */

import type { Pool } from 'pg';
import type { ContextScope } from './scope-planner';

export interface AssembledSection {
  content: string[];
  memory_ids: string[];
  tokens_used: number;
}

export interface AssembledContext {
  sections: Record<string, AssembledSection>;
  source_memories: Array<{ memory_id: string; score: number; trust_level: string }>;
  total_tokens: number;
}

const APPROX_CHARS_PER_TOKEN = 4;

const TRUST_LEVELS = ['t0_raw', 't1_extracted', 't2_validated', 't3_committed', 't4_human', 't5_canonical'];

function trustLevelFilter(trustMin: string): string[] {
  const minIdx = TRUST_LEVELS.indexOf(trustMin);
  return minIdx >= 0 ? TRUST_LEVELS.slice(minIdx) : TRUST_LEVELS;
}

interface MemoryRow {
  memory_id: string;
  content: string;
  summary: string | null;
  trust_level: string;
  importance_score: number | null;
}

async function queryMemories(
  db: Pool,
  memoryTypes: string[],
  trustLevels: string[],
  projectId: string | null | undefined,
  projectInclusive: boolean,
  excludeIds: Set<string>,
  limit: number
): Promise<MemoryRow[]> {
  const conditions: string[] = ["status = 'active'"];
  const params: unknown[] = [];
  let idx = 1;

  conditions.push(`memory_type = ANY($${idx++}::text[])`);
  params.push(memoryTypes);

  conditions.push(`trust_level = ANY($${idx++}::text[])`);
  params.push(trustLevels);

  if (projectId) {
    if (projectInclusive) {
      conditions.push(`(project_id = $${idx++} OR project_id IS NULL)`);
    } else {
      conditions.push(`project_id = $${idx++}`);
    }
    params.push(projectId);
  }

  if (excludeIds.size > 0) {
    conditions.push(`memory_id != ALL($${idx++}::text[])`);
    params.push([...excludeIds]);
  }

  params.push(limit);

  const sql = `
    SELECT memory_id, content, summary, trust_level, importance_score
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY importance_score DESC NULLS LAST, created_at DESC
    LIMIT $${idx}
  `;

  const { rows } = await db.query<MemoryRow>(sql, params);
  return rows;
}

export async function assembleContext(
  db: Pool,
  scope: ContextScope,
  filters: { project_id?: string | null; trust_min?: string }
): Promise<AssembledContext> {
  const trustLevels = trustLevelFilter(filters.trust_min ?? 't2_validated');
  const projectId = filters.project_id ?? null;

  const allSourceMemories: Array<{ memory_id: string; score: number; trust_level: string }> = [];
  const assembledSections: Record<string, AssembledSection> = {};
  const usedMemoryIds = new Set<string>();
  let totalTokens = 0;

  // Process sections in priority order so high-priority sections claim memories first
  const sortedEntries = Object.entries(scope.sections)
    .sort(([, a], [, b]) => a.priority - b.priority);

  for (const [sectionKey, sectionScope] of sortedEntries) {
    // Synthesized sections (memory_types: []) are filled by the generator, not here
    if (sectionScope.memory_types.length === 0) {
      assembledSections[sectionKey] = { content: [], memory_ids: [], tokens_used: 0 };
      continue;
    }

    // Primary query
    let rows = await queryMemories(
      db, sectionScope.memory_types, trustLevels, projectId,
      false, usedMemoryIds, 10
    );

    // Fallback query: if primary returned nothing and fallback types are defined
    if (rows.length === 0 && sectionScope.fallback_memory_types && sectionScope.fallback_memory_types.length > 0) {
      rows = await queryMemories(
        db, sectionScope.fallback_memory_types, trustLevels, projectId,
        true,  // inclusive: (project_id = $x OR project_id IS NULL)
        usedMemoryIds, 10
      );
    }

    const section: AssembledSection = { content: [], memory_ids: [], tokens_used: 0 };
    let sectionTokens = 0;

    for (const row of rows) {
      const text = row.summary ?? row.content;
      const approxTokens = Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);

      if (sectionTokens + approxTokens > sectionScope.token_budget) break;

      section.content.push(text);
      section.memory_ids.push(row.memory_id);
      section.tokens_used += approxTokens;
      sectionTokens += approxTokens;

      usedMemoryIds.add(row.memory_id);
      allSourceMemories.push({
        memory_id: row.memory_id,
        score: row.importance_score ?? 0.5,
        trust_level: row.trust_level,
      });
    }

    assembledSections[sectionKey] = section;
    totalTokens += sectionTokens;
  }

  return {
    sections: assembledSections,
    source_memories: allSourceMemories,
    total_tokens: totalTokens,
  };
}
