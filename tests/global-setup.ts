import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../src/shared/config.js';

export async function setup(): Promise<() => Promise<void>> {
  const testUrl = new URL(config.TEST_DATABASE_URL);
  const testDatabase = testUrl.pathname.slice(1);
  if (testDatabase !== 'events_test') throw new Error('TEST_DATABASE_URL must point to events_test');

  const adminUrl = new URL(config.TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDatabase]);
    if (exists.rowCount === 0) await adminPool.query('CREATE DATABASE events_test');
  } finally {
    await adminPool.end();
  }

  const pool = new Pool({ connectionString: config.TEST_DATABASE_URL });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', ['001_init.sql']);
    if (applied.rowCount === 0) {
      const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', ['001_init.sql']);
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await pool.end();
  }

  return async () => undefined;
}

