/**
 * Deduper — detects likely duplicate proposals before insertion.
 */

export interface DedupeCandidate {
  memory_id: string;
  content: string;
  memory_type: string;
}

export interface DedupeResult {
  is_duplicate: boolean;
  duplicate_of: string | null;
  similarity: number;
}

export function dedupe(
  proposedContent: string,
  proposedType: string,
  candidates: DedupeCandidate[]
): DedupeResult {
  const proposedTokens = tokenize(proposedContent);
  let bestScore = 0;
  let bestMatch: string | null = null;

  for (const candidate of candidates) {
    if (candidate.memory_type !== proposedType) continue;
    const candidateTokens = tokenize(candidate.content);
    const score = jaccard(proposedTokens, candidateTokens);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate.memory_id;
    }
  }

  const DUPLICATE_THRESHOLD = 0.75;
  return {
    is_duplicate: bestScore >= DUPLICATE_THRESHOLD,
    duplicate_of: bestScore >= DUPLICATE_THRESHOLD ? bestMatch : null,
    similarity: bestScore,
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s\u3000-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}
