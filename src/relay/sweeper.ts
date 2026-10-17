import type { Redis } from 'ioredis';
import { config } from '../shared/config.js';
import { pool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { sweeperRequeued } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';

const STREAM = 'events:stream';
const ADVISORY_LOCK = 7001;

export interface SweeperDependencies {
  redisClient?: Redis;
  poolClient?: typeof pool;
}

export async function sweepOnce(dependencies: SweeperDependencies = {}): Promise<number> {
  const redisClient = dependencies.redisClient ?? redis;
  const poolClient = dependencies.poolClient ?? pool;
  const client = await poolClient.connect();
  let acquired = false;
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK]);
    acquired = lock.rows[0]?.locked === true;
    if (!acquired) return 0;

    await client.query('BEGIN');
    const rows = await client.query<{ id: string; type: string }>(
      `UPDATE events SET updated_at = now()
        WHERE id IN (
          SELECT id FROM events
           WHERE status IN ('received', 'retrying')
             AND updated_at < now() - ($1 * interval '1 millisecond')
           ORDER BY updated_at
           LIMIT 500
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type`,
      [config.SWEEP_STALE_MS],
    );
    await client.query('COMMIT');

    for (const row of rows.rows) {
      try {
        await redisClient.xadd(STREAM, '*', 'event_id', row.id, 'type', row.type);
        sweeperRequeued.inc();
      } catch (error) {
        logger.error({ err: error, event_id: row.id }, 'sweeper requeue failed');
      }
    }
    return rows.rowCount ?? 0;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original database error */ }
    throw error;
  } finally {
    if (acquired) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK]); } catch (error) {
        logger.error({ err: error }, 'sweeper advisory lock release failed');
      }
    }
    client.release();
  }
}

export class Sweeper {
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;

  constructor(private readonly dependencies: SweeperDependencies = {}) {}

  start(): void {
    this.timer = globalThis.setInterval(() => {
      if (this.current) return;
      this.current = sweepOnce(this.dependencies)
        .then(() => undefined)
        .catch((error) => logger.error({ err: error }, 'sweeper cycle failed'))
        .finally(() => { this.current = undefined; });
    }, config.SWEEP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) globalThis.clearInterval(this.timer);
    await this.current;
  }
}
