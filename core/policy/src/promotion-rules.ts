/**
 * Promotion rules — computes promotion score and determines next trust level.
 */

import rules from '../../schemas/promotion-rules.json';
import { type TrustLevel } from './trust-model';

export interface PromotionScore {
  score: number;
  next_level: TrustLevel | null;
  can_auto_promote: boolean;
}

export interface ScoringInputs {
  memory_type: string;
  importance: number;
  reusability: number;
  stability: number;
  explicitness: number;
  evidence_strength: number;
}

export function computePromotionScore(inputs: ScoringInputs): number {
  const w = rules.weights;
  return (
    inputs.importance * w.importance +
    inputs.reusability * w.reusability +
    inputs.stability * w.stability +
    inputs.explicitness * w.explicitness +
    inputs.evidence_strength * w.evidence_strength
  );
}

export function getNextTrustLevel(
  current: TrustLevel,
  score: number,
  memory_type: string,
  content: string
): PromotionScore {
  const neverAuto = (rules.never_auto_promote as string[]).includes(memory_type);
  const autoType = (rules.auto_promote as Record<string, boolean>)[memory_type] === true;

  const hasExplicitSignal = (rules.explicit_signals as string[]).some(
    sig => content.includes(sig)
  );

  let next_level: TrustLevel | null = null;
  let can_auto_promote = false;

  if (current === 't1_extracted' && score >= rules.thresholds.to_validated) {
    next_level = 't2_validated';
    can_auto_promote = !neverAuto || autoType;
  } else if (current === 't2_validated' && score >= rules.thresholds.to_committed) {
    next_level = 't3_committed';
    can_auto_promote = !neverAuto && (autoType || hasExplicitSignal);
  } else if (current === 't3_committed' && score >= rules.thresholds.to_canonical) {
    next_level = 't5_canonical';
    can_auto_promote = false;
  }

  return { score, next_level, can_auto_promote };
}
