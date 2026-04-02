import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { generateHandoffContext } from '@memory-os/core-context';

export async function contextRoute(
  app: FastifyInstance,
  opts: { db: Pool }
) {
  app.post('/context', async (req, reply) => {
    const body = req.body as {
      intent?: string;
      role?: string;
      project_id?: string | null;
      query?: string;
      token_budget?: number;
    };

    const context = await generateHandoffContext(opts.db, {
      intent: body.intent,
      role: body.role,
      project_id: body.project_id,
      query: body.query,
      token_budget: body.token_budget,
    });

    return context;
  });
}
