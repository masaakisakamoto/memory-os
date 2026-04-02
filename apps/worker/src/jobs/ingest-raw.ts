/**
 * ingest-raw — reads a raw session JSON file and writes to sessions + raw_events tables.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Pool } from 'pg';

interface RawSessionFile {
  session_id: string;
  project_id?: string;
  started_at: string;
  ended_at?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  events: Array<{
    event_id: string;
    event_type: string;
    role: string;
    content: string;
    occurred_at: string;
    sequence_num: number;
    metadata?: Record<string, unknown>;
  }>;
}

export async function ingestRaw(db: Pool, filePath: string): Promise<void> {
  const absPath = resolve(filePath);
  console.log(`Ingesting: ${absPath}`);

  const raw = readFileSync(absPath, 'utf8');
  const session: RawSessionFile = JSON.parse(raw);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO sessions (session_id, project_id, started_at, ended_at, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE SET ended_at = EXCLUDED.ended_at, metadata = EXCLUDED.metadata`,
      [
        session.session_id,
        session.project_id ?? null,
        session.started_at,
        session.ended_at ?? null,
        session.source ?? 'manual',
        JSON.stringify(session.metadata ?? {}),
      ]
    );
    console.log(`Session ${session.session_id} upserted`);

    for (const evt of session.events) {
      await client.query(
        `INSERT INTO raw_events (event_id, session_id, event_type, role, content, occurred_at, sequence_num, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          evt.event_id,
          session.session_id,
          evt.event_type,
          evt.role,
          evt.content,
          evt.occurred_at,
          evt.sequence_num,
          JSON.stringify(evt.metadata ?? {}),
        ]
      );
    }
    console.log(`${session.events.length} events ingested`);

    await client.query('COMMIT');
    console.log('Ingest complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
