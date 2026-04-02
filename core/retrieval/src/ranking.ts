/**
 * Ranking — re-ranks search results by combining trust, importance, and recency.
 */

import { trustValue } from '@memory-os/core-policy';
import type { TrustLevel } from '@memory-os/core-policy';

export interface RankableMemory {
  memory_id: string;
  trust_level: TrustLevel;
  importance_score: number | null;
  valid_from: string;
  rank?: number;
}

export function rerankMemories<T extends RankableMemory>(
  memories: T[],
  now = new Date()
): T[] {
  const scored = memories.map(m => ({
    ...m,
    _combined_score: combinedScore(m, now),
  }));
  return scored.sort((a, b) => b._combined_score - a._combined_score);
}

function combinedScore(m: RankableMemory, now: Date): number {
  const trust = trustValue(m.trust_level) / 5;
  const importance = m.importance_score ?? 0.5;
  const recency = recencyScore(m.valid_from, now);
  const textRank = m.rank ?? 1.0;

  return trust * 0.35 + importance * 0.30 + recency * 0.15 + textRank * 0.20;
}

function recencyScore(validFrom: string, now: Date): number {
  const ageDays = (now.getTime() - new Date(validFrom).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 45);
}
