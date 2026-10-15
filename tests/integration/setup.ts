import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../../src/shared/config.js';
import { createRedis } from '../../src/shared/redis.js';

export const testPool = new Pool({ connectionString: config.TEST_DATABASE_URL, max: 20 });
export const testRedis = createRedis(config.TEST_REDIS_URL);

export async function testQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  return testPool.query<T>(text, values);
}

export async function testWithTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
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

export async function resetTestState(): Promise<void> {
  await testQuery('TRUNCATE outbox, events, wallets, ledger_entries RESTART IDENTITY CASCADE');
  await testRedis.flushdb();
}

export async function closeTestResources(): Promise<void> {
  await testRedis.quit();
  await testPool.end();
}
