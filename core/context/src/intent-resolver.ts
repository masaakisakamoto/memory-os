/**
 * Intent resolver — determines the context-building intent from a request.
 */

export type ContextIntent = 'handoff' | 'task' | 'search' | 'review';

export interface IntentResolution {
  intent: ContextIntent;
  role: string;
  project_id: string | null;
  signals: string[];
}

export function resolveIntent(
  input: {
    intent?: string;
    role?: string;
    project_id?: string | null;
    query?: string;
  }
): IntentResolution {
  const role = input.role ?? 'assistant';
  const project_id = input.project_id ?? null;
  const signals: string[] = [];

  let intent: ContextIntent = 'handoff';

  if (input.intent) {
    const normalized = input.intent.toLowerCase();
    if (['handoff', 'task', 'search', 'review'].includes(normalized)) {
      intent = normalized as ContextIntent;
      signals.push(`explicit:${intent}`);
    }
  } else if (input.query) {
    const q = input.query.toLowerCase();
    if (q.includes('handoff') || q.includes('引き継ぎ') || q.includes('next session')) {
      intent = 'handoff';
      signals.push('inferred:handoff_keyword');
    } else if (q.includes('task') || q.includes('タスク') || q.includes('implement')) {
      intent = 'task';
      signals.push('inferred:task_keyword');
    } else if (q.includes('search') || q.includes('find') || q.includes('検索')) {
      intent = 'search';
      signals.push('inferred:search_keyword');
    }
  }

  return { intent, role, project_id, signals };
}
