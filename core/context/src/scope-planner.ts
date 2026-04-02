/**
 * Scope planner — determines which memory types to include and their token allocations.
 *
 * Handoff priority order (most critical for next-chat continuity first):
 *   1. relationship            — who we are collaborating with and how
 *   2. global_policies         — durable rules that always apply
 *   3. active_project          — what we are building right now
 *   4. relevant_decisions      — decisions that constrain the work
 *   5. strategic_next_actions  — synthesized; where the project is heading
 *   6. operational_next_actions— synthesized; immediate tasks and approval queue
 *   7. open_loops              — synthesized; unresolved threads
 *   8. recent_episodes         — what happened recently
 *   9. identity                — who the user is (context, not priority)
 *  10. evidence                — supporting facts
 *  11. procedures              — how-to references
 *  12. task_frame              — handoff summary
 *
 * Sections with memory_types: [] are synthesized by the handoff generator,
 * not queried from the database.
 *
 * fallback_memory_types: queried only when the primary memory_types return no rows.
 * Fallback queries use (project_id = $x OR project_id IS NULL) to include global memories.
 * IMPORTANT: relationship never falls back to identity — they are semantically distinct.
 * active_project has no scope-level fallback; deriveProjectFallback() in the generator
 * handles it to avoid mixing identity/policy into project state.
 */

import type { ContextIntent } from './intent-resolver';

export interface ScopeSection {
  memory_types: string[];
  fallback_memory_types?: string[];
  token_budget: number;
  priority: number;
  required: boolean;
}

export interface ContextScope {
  sections: Record<string, ScopeSection>;
  total_budget: number;
}

const HANDOFF_SCOPE: Record<string, ScopeSection> = {
  // Relationship: episode as fallback only — never identity (different semantic)
  relationship:            { memory_types: ['relationship'],    fallback_memory_types: ['episode'],  token_budget: 250, priority: 1,  required: true  },
  global_policies:         { memory_types: ['policy'],                                               token_budget: 250, priority: 2,  required: true  },
  // Active project: no scope-level fallback — generator's deriveProjectFallback handles it cleanly
  active_project:          { memory_types: ['project_state'],                                        token_budget: 300, priority: 3,  required: true  },
  // Decisions: episode as fallback; generator also has deriveDecisionsFallback that bypasses dedup
  relevant_decisions:      { memory_types: ['decision'],        fallback_memory_types: ['episode'],  token_budget: 200, priority: 4,  required: false },
  // Synthesized — memory_types: [] means the generator fills these, not the assembler
  strategic_next_actions:  { memory_types: [],                                                       token_budget: 150, priority: 5,  required: false },
  operational_next_actions:{ memory_types: [],                                                       token_budget: 150, priority: 6,  required: false },
  open_loops:              { memory_types: [],                                                       token_budget: 150, priority: 7,  required: false },
  recent_episodes:         { memory_types: ['episode'],                                              token_budget: 200, priority: 8,  required: false },
  identity:                { memory_types: ['identity'],                                             token_budget: 150, priority: 9,  required: false },
  evidence:                { memory_types: ['evidence'],                                             token_budget: 100, priority: 10, required: false },
  procedures:              { memory_types: ['procedure'],                                            token_budget: 150, priority: 11, required: false },
  task_frame:              { memory_types: ['handoff_summary'],                                      token_budget: 150, priority: 12, required: false },
};

const TASK_SCOPE: Record<string, ScopeSection> = {
  global_policies:         { memory_types: ['policy'],                                               token_budget: 400, priority: 1,  required: true  },
  active_project:          { memory_types: ['project_state'],                                        token_budget: 400, priority: 2,  required: true  },
  relevant_decisions:      { memory_types: ['decision'],        fallback_memory_types: ['episode'],  token_budget: 300, priority: 3,  required: true  },
  procedures:              { memory_types: ['procedure'],                                            token_budget: 300, priority: 4,  required: true  },
  strategic_next_actions:  { memory_types: [],                                                       token_budget: 150, priority: 5,  required: false },
  operational_next_actions:{ memory_types: [],                                                       token_budget: 150, priority: 6,  required: false },
  open_loops:              { memory_types: [],                                                       token_budget: 100, priority: 7,  required: false },
  recent_episodes:         { memory_types: ['episode'],                                              token_budget: 100, priority: 8,  required: false },
  identity:                { memory_types: ['identity'],                                             token_budget: 100, priority: 9,  required: false },
  relationship:            { memory_types: ['relationship'],    fallback_memory_types: ['episode'],  token_budget: 100, priority: 10, required: false },
  evidence:                { memory_types: ['evidence'],                                             token_budget: 200, priority: 11, required: false },
  task_frame:              { memory_types: ['handoff_summary'],                                      token_budget: 100, priority: 12, required: false },
};

export function planScope(intent: ContextIntent, targetTokens = 2000): ContextScope {
  const base = intent === 'task' ? TASK_SCOPE : HANDOFF_SCOPE;

  const baseTotal = Object.values(base).reduce((s, v) => s + v.token_budget, 0);
  const scale = targetTokens / baseTotal;

  const sections: Record<string, ScopeSection> = {};
  for (const [key, sec] of Object.entries(base)) {
    sections[key] = { ...sec, token_budget: Math.floor(sec.token_budget * scale) };
  }

  return { sections, total_budget: targetTokens };
}
