/**
 * Trust model — maps trust levels to numeric values and enforces ordering.
 */

export type TrustLevel = 't0_raw' | 't1_extracted' | 't2_validated' | 't3_committed' | 't4_human' | 't5_canonical';

export const TRUST_ORDER: Record<TrustLevel, number> = {
  t0_raw: 0,
  t1_extracted: 1,
  t2_validated: 2,
  t3_committed: 3,
  t4_human: 4,
  t5_canonical: 5,
};

export function trustValue(level: TrustLevel): number {
  return TRUST_ORDER[level] ?? 0;
}

export function isAtLeast(level: TrustLevel, minimum: TrustLevel): boolean {
  return trustValue(level) >= trustValue(minimum);
}

export function canBeUsedInContext(level: TrustLevel): boolean {
  return trustValue(level) >= TRUST_ORDER['t2_validated'];
}

export function sortByTrust<T extends { trust_level: TrustLevel }>(items: T[]): T[] {
  return [...items].sort((a, b) => trustValue(b.trust_level) - trustValue(a.trust_level));
}
