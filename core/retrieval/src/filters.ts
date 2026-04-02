/**
 * Filters — composable filter builders for memory queries.
 */

export interface MemoryFilters {
  project_id?: string | null;
  memory_types?: string[];
  trust_min?: string;
  status?: string;
  valid_at?: string;
}

export function buildWhereClause(
  filters: MemoryFilters,
  startParamIdx = 1
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = startParamIdx;

  const status = filters.status ?? 'active';
  conditions.push(`status = $${idx++}`);
  params.push(status);

  if (filters.project_id) {
    conditions.push(`project_id = $${idx++}`);
    params.push(filters.project_id);
  }

  if (filters.memory_types && filters.memory_types.length > 0) {
    conditions.push(`memory_type = ANY($${idx++}::text[])`);
    params.push(filters.memory_types);
  }

  if (filters.trust_min) {
    const TRUST_LEVELS = ['t0_raw', 't1_extracted', 't2_validated', 't3_committed', 't4_human', 't5_canonical'];
    const minIdx = TRUST_LEVELS.indexOf(filters.trust_min);
    if (minIdx >= 0) {
      const allowed = TRUST_LEVELS.slice(minIdx);
      conditions.push(`trust_level = ANY($${idx++}::text[])`);
      params.push(allowed);
    }
  }

  if (filters.valid_at) {
    conditions.push(`valid_from <= $${idx++}`);
    params.push(filters.valid_at);
    conditions.push(`(valid_to IS NULL OR valid_to > $${idx++})`);
    params.push(filters.valid_at);
  }

  return {
    where: conditions.length > 0 ? conditions.join(' AND ') : 'TRUE',
    params,
  };
}
