import type { Redis } from 'ioredis';
import type { PoolClient } from 'pg';
import { crashAfterRelayXadd } from '../shared/chaos.js';
import { config } from '../shared/config.js';
import { pool, withTx } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { streamLength } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';

const STREAM = 'events:stream';

export interface RelayDependencies {
  redisClient?: Redis;
  withTxFn?: typeof withTx;
  batchSize?: number;
  pollMs?: number;
}

export async function publishBatch(client: PoolClient, redisClient: Redis, batchSize: number): Promise<number> {
  const rows = await client.query<{ id: string; event_id: string; type: string }>(
    `SELECT o.id, o.event_id, e.type
       FROM outbox o
       JOIN events e ON e.id = o.event_id
      WHERE o.published_at IS NULL
      ORDER BY o.id
      LIMIT $1
      -- Lock only outbox rows so workers can contend on event rows independently.
      FOR UPDATE OF o SKIP LOCKED`,
    [batchSize],
  );
  if (rows.rowCount === 0) return 0;

  for (const row of rows.rows) {
    await redisClient.xadd(STREAM, '*', 'event_id', row.event_id, 'type', row.type);
    crashAfterRelayXadd();
  }

  await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.rows.map((row) => row.id)]);
  return rows.rows.length;
}

export async function pollOnce(dependencies: RelayDependencies = {}): Promise<number> {
  const redisClient = dependencies.redisClient ?? redis;
  const withTxFn = dependencies.withTxFn ?? withTx;
  const batchSize = dependencies.batchSize ?? config.RELAY_BATCH;
  try {
    const published = await withTxFn((client) => publishBatch(client, redisClient, batchSize));
    streamLength.set(await redisClient.xlen(STREAM));
    return published;
  } catch (error) {
    streamLength.set(await redisClient.xlen(STREAM));
    throw error;
  }
}

export class Relay {
  private stopped = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly dependencies: RelayDependencies = {}) {}

  start(): Promise<void> {
    this.loopPromise = this.run();
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
  }

  private async run(): Promise<void> {
    const pollMs = this.dependencies.pollMs ?? config.RELAY_POLL_MS;
    while (!this.stopped) {
      try {
        await pollOnce(this.dependencies);
      } catch (error) {
        logger.error({ err: error }, 'relay poll failed');
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export async function closeRelayResources(): Promise<void> {
  await Promise.all([pool.end(), redis.quit()]);
}
