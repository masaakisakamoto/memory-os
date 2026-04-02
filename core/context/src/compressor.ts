/**
 * Compressor — truncates or summarizes sections when over token budget.
 */

export type CompressionLevel = 'none' | 'light' | 'aggressive';

export function determineCompressionLevel(used: number, target: number): CompressionLevel {
  const ratio = used / target;
  if (ratio <= 1.0) return 'none';
  if (ratio <= 1.3) return 'light';
  return 'aggressive';
}

export function compressContent(
  content: string[],
  tokenBudget: number,
  level: CompressionLevel
): string[] {
  if (level === 'none') return content;

  const charsPerToken = 4;
  const charBudget = tokenBudget * charsPerToken;

  if (level === 'light') {
    return content.map(c => c.length > 150 ? c.substring(0, 147) + '...' : c);
  }

  const result: string[] = [];
  let usedChars = 0;
  for (const item of content) {
    if (usedChars >= charBudget) break;
    const truncated = item.length > 80 ? item.substring(0, 77) + '...' : item;
    result.push(truncated);
    usedChars += truncated.length;
  }
  return result;
}
