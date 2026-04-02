import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { hydrateMemory } from '@memory-os/core-retrieval';

export async function memoriesRoute(
  app: FastifyInstance,
  opts: { db: Pool }
) {
  app.get('/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const memory = await hydrateMemory(opts.db, id);
    if (!memory) {
      return reply.status(404).send({ error: 'Memory not found' });
    }
    return memory;
  });
}
