import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { config } from '../src/shared/config.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pool = new Pool({ connectionString: config.DATABASE_URL });
try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const name = '001_init.sql';
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  if (applied.rowCount === 0) {
    const sql = await readFile(join(root, 'migrations', name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [basename(name)]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    console.log(`Skipped ${name}`);
  }
} finally {
  await pool.end();
}

