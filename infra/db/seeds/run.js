#!/usr/bin/env node
// Seed runner - loads fixture data into the database
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/memory_os'
  });

  await client.connect();
  console.log('Connected, seeding fixtures...');

  // Load sample session
  const sessionFile = path.join(__dirname, '../../../data/fixtures/raw/sample-session.json');
  if (fs.existsSync(sessionFile)) {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    try {
      await client.query(
        `INSERT INTO sessions (session_id, project_id, started_at, source, metadata)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [session.session_id, session.project_id, session.started_at, session.source, JSON.stringify(session.metadata || {})]
      );
      for (const evt of session.events || []) {
        await client.query(
          `INSERT INTO raw_events (event_id, session_id, event_type, role, content, occurred_at, sequence_num, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [evt.event_id, session.session_id, evt.event_type, evt.role, evt.content, evt.occurred_at, evt.sequence_num, JSON.stringify(evt.metadata || {})]
        );
      }
      console.log('Seeded sample session');
    } catch (err) {
      console.error('Seed error:', err.message);
    }
  }

  await client.end();
  console.log('Seed complete');
}

run().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
