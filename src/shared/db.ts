import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from './config.js';

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly kind: 'unique' | 'transient' | 'unknown',
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export function mapDatabaseError(error: unknown): DatabaseError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  if (code === '23505') return new DatabaseError('Unique constraint violation', 'unique', code);
  if (['40001', '40P01', '55P03'].includes(code ?? '')) {
    return new DatabaseError('Transient database error', 'transient', code);
  }
  return new DatabaseError('Database error', 'unknown', code);
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

