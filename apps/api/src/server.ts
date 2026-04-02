import Fastify from 'fastify';
import { Pool } from 'pg';
import { searchRoute } from './routes/search';
import { contextRoute } from './routes/context';
import { proposalsRoute } from './routes/proposals';
import { memoriesRoute } from './routes/memories';

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/memory_os',
});

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.register(searchRoute, { db });
app.register(contextRoute, { db });
app.register(proposalsRoute, { db });
app.register(memoriesRoute, { db });

const port = parseInt(process.env.API_PORT || '3000', 10);
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
