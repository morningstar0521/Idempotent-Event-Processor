import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { config } from '../shared/config.js';

const migrationPath = fileURLToPath(new URL('../../migrations/001_init.sql', import.meta.url));
const pool = new Pool({ connectionString: config.DATABASE_URL });

try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', ['001_init.sql']);
  if (applied.rowCount === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(migrationPath, 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', ['001_init.sql']);
      await client.query('COMMIT');
      console.log('Applied 001_init.sql');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    console.log('Skipped 001_init.sql');
  }
} finally {
  await pool.end();
}
