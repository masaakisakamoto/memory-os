/**
 * Extractor v0 — deterministic heuristic-based proposal extractor.
 * Does NOT call any external AI APIs.
 */

import { randomUUID } from 'crypto';
import promotionRules from '../../schemas/promotion-rules.json';

export interface RawEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  occurred_at: string;
  sequence_num: number;
  metadata: Record<string, unknown>;
}

export interface ProposalDraft {
  proposal_id: string;
  session_id: string;
  memory_type: string;
  operation: 'create' | 'update' | 'supersede' | 'invalidate';
  target_memory_id: string | null;
  proposed_content: string;
  reason: string;
  source_refs: string[];
  confidence: number;
  risk_level: 'low' | 'medium' | 'high';
  approval_required: boolean;
  proposer: string;
  conflict_candidates: string[];
  created_at: string;
}

const HEURISTIC_RULES: Array<{
  pattern: RegExp;
  memory_type: string;
  confidence: number;
  risk_level: 'low' | 'medium' | 'high';
}> = [
  { pattern: /この方針で|今後は|長期的に/, memory_type: 'policy', confidence: 0.9, risk_level: 'low' },
  { pattern: /覚えて|覚えておいて|記録して/, memory_type: 'project_state', confidence: 0.85, risk_level: 'low' },
  { pattern: /決定しました|決めました|決断しました|にすることにした/, memory_type: 'decision', confidence: 0.8, risk_level: 'medium' },
  { pattern: /私は.*(エンジニア|開発者|デザイナー|マネージャー|researcher|developer|engineer)/i, memory_type: 'identity', confidence: 0.75, risk_level: 'high' },
  { pattern: /好みは|好きなのは|prefer|気に入って/, memory_type: 'preference', confidence: 0.7, risk_level: 'low' },
  { pattern: /手順は|手順:|やり方は|方法は|steps?:/, memory_type: 'procedure', confidence: 0.7, risk_level: 'medium' },
  { pattern: /一緒に|協力して|チームで|with.*team/i, memory_type: 'relationship', confidence: 0.65, risk_level: 'high' },
  { pattern: /プロジェクト|project|実装中|進捗|status/i, memory_type: 'project_state', confidence: 0.6, risk_level: 'low' },
  { pattern: /.{40,}/, memory_type: 'episode', confidence: 0.4, risk_level: 'low' },
];

export function extractProposals(events: RawEvent[], sessionId: string): ProposalDraft[] {
  const proposals: ProposalDraft[] = [];

  for (const event of events) {
    if (event.role !== 'user') continue;
    if (!event.content || event.content.trim().length < 10) continue;

    const matched = matchHeuristics(event.content);
    if (!matched) continue;

    const hasExplicitSignal = (promotionRules.explicit_signals as string[]).some(
      sig => event.content.includes(sig)
    );
    const confidence = Math.min(1, matched.confidence + (hasExplicitSignal ? 0.05 : 0));

    proposals.push({
      proposal_id: `prop_${randomUUID().replace(/-/g, '').substring(0, 12)}`,
      session_id: sessionId,
      memory_type: matched.memory_type,
      operation: 'create',
      target_memory_id: null,
      proposed_content: event.content.trim(),
      reason: `Matched heuristic for ${matched.memory_type} in event ${event.event_id}`,
      source_refs: [`${sessionId}:${event.event_id}`],
      confidence,
      risk_level: matched.risk_level,
      approval_required: requiresApproval(matched.memory_type),
      proposer: 'extractor_v0',
      conflict_candidates: [],
      created_at: new Date().toISOString(),
    });
  }

  return proposals;
}

function matchHeuristics(content: string): typeof HEURISTIC_RULES[0] | null {
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(content)) return rule;
  }
  return null;
}

function requiresApproval(memory_type: string): boolean {
  const noApprovalNeeded = ['episode', 'evidence', 'artifact_reference', 'handoff_summary'];
  return !noApprovalNeeded.includes(memory_type);
}
