/**
 * MCP tool: get_context
 */

import type { Pool } from 'pg';
import { generateHandoffContext } from '@memory-os/core-context';

export async function getContext(
  db: Pool,
  params: Record<string, unknown>
): Promise<unknown> {
  const intent = typeof params.intent === 'string' ? params.intent : 'handoff';
  const role = typeof params.role === 'string' ? params.role : 'assistant';
  const project_id = typeof params.project_id === 'string' ? params.project_id : null;
  const token_budget = typeof params.token_budget === 'number' ? params.token_budget : 2000;

  return generateHandoffContext(db, { intent, role, project_id, token_budget });
}
