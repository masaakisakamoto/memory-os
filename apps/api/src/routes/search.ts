import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { searchMemories } from '@memory-os/core-retrieval';
import { rerankMemories } from '@memory-os/core-retrieval';

export async function searchRoute(
  app: FastifyInstance,
  opts: { db: Pool }
) {
  app.post('/search', async (req, reply) => {
    const body = req.body as {
      q?: string;
      project_id?: string;
      memory_types?: string[];
      trust_min?: string;
      limit?: number;
    };

    if (!body.q && !body.memory_types) {
      return reply.status(400).send({ error: 'q or memory_types required' });
    }

    const results = await searchMemories(opts.db, {
      q: body.q ?? '',
      project_id: body.project_id,
      memory_types: body.memory_types,
      trust_min: body.trust_min,
      limit: body.limit ?? 20,
    });

    const reranked = rerankMemories(results as any);
    return { results: reranked, count: reranked.length };
  });
}
