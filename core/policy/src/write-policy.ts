/**
 * Write policy enforcement.
 */

import policy from '../../schemas/write-policy.json';

export interface PolicyDecision {
  can_propose: boolean;
  auto_approve: boolean | 'conditional';
  human_required: boolean;
  approval_required: boolean;
}

export function getPolicyDecision(memory_type: string, confidence: number): PolicyDecision {
  const rule = (policy as Record<string, { propose: boolean; auto_approve: boolean | 'conditional'; human_required: boolean }>)[memory_type];

  if (!rule) {
    return {
      can_propose: false,
      auto_approve: false,
      human_required: true,
      approval_required: true,
    };
  }

  const effectiveAutoApprove =
    rule.auto_approve === 'conditional'
      ? confidence >= 0.7
      : rule.auto_approve;

  return {
    can_propose: rule.propose,
    auto_approve: effectiveAutoApprove,
    human_required: rule.human_required,
    approval_required: !effectiveAutoApprove || rule.human_required,
  };
}

export function canAutoApprove(memory_type: string, confidence: number, risk_level: string): boolean {
  if (risk_level === 'high') return false;
  const decision = getPolicyDecision(memory_type, confidence);
  return decision.auto_approve === true && !decision.human_required;
}
