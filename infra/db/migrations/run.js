#!/usr/bin/env node
// Simple migration runner for Memory OS
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/memory_os'
  });

  await client.connect();
  console.log('Connected to database');

  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Execute statements individually (skip \i directives)
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('\\'));

  for (const stmt of statements) {
    try {
      await client.query(stmt);
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('  (already exists, skipping)');
      } else {
        console.error('Error:', err.message);
        console.error('Statement:', stmt.substring(0, 80));
      }
    }
  }

  console.log('Migration complete');
  await client.end();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
