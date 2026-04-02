/**
 * MCP Server scaffold — exposes Memory OS read/propose tools via MCP protocol.
 */

import { Pool } from 'pg';

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/memory_os',
});

export { db };

// Minimal stdio-based MCP scaffold
process.stdin.setEncoding('utf8');
let inputBuffer = '';

process.stdin.on('data', async (chunk: string) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      const response = await handleRequest(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ error: (err as Error).message }) + '\n');
    }
  }
});

async function handleRequest(req: { method: string; params?: Record<string, unknown> }) {
  const { method, params = {} } = req;

  switch (method) {
    case 'search_knowledge': {
      const { searchKnowledge } = await import('./tools/search-knowledge');
      return searchKnowledge(db, params);
    }
    case 'get_context': {
      const { getContext } = await import('./tools/get-context');
      return getContext(db, params);
    }
    case 'propose_memory': {
      const { proposeMemory } = await import('./tools/propose-memory');
      return proposeMemory(db, params);
    }
    default:
      return { error: `Unknown tool: ${method}` };
  }
}
