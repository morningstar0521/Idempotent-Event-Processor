import type { Redis } from 'ioredis';
import { PermanentError } from '../domain/errors.js';
import { config } from '../shared/config.js';
import { withTx } from '../shared/db.js';
import { eventsDead, eventsFailed, eventsRetried } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';

const STREAM = 'events:stream';
const GROUP = 'workers';
const DELAYED = 'events:delayed';

type FailureMessage = { id: string };
type ErrorWithCode = { code?: unknown };

export interface FailureDependencies {
  redisClient?: Redis;
  withTxFn?: typeof withTx;
  rng?: () => number;
  now?: () => number;
}

export function classify(error: unknown): 'transient' | 'permanent' {
  if (error instanceof PermanentError) return 'permanent';
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as ErrorWithCode).code)
    : undefined;
  if (['40001', '40P01', '55P03', 'ECONNRESET', 'ETIMEDOUT'].includes(code ?? '')) return 'transient';
  return 'transient';
}

export function computeBackoff(attempts: number, rng: () => number = Math.random): number {
  const exponent = Math.max(0, attempts - 1);
  const cap = Math.min(config.BACKOFF_CAP_MS, config.BACKOFF_BASE_MS * 2 ** exponent);
  const value = rng();
  const random = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(cap, random * cap));
}

async function ackAndDelete(message: FailureMessage, redisClient: Redis): Promise<void> {
  await redisClient.xack(STREAM, GROUP, message.id);
  await redisClient.xdel(STREAM, message.id);
}

export async function handleFailure(
  id: string,
  error: unknown,
  message: FailureMessage,
  dependencies: FailureDependencies = {},
): Promise<void> {
  const kind = classify(error);
  const redisClient = dependencies.redisClient ?? redis;
  const withTxFn = dependencies.withTxFn ?? withTx;
  const rng = dependencies.rng ?? Math.random;
  const now = dependencies.now ?? Date.now;
  eventsFailed.inc({ kind });

  const result = await withTxFn(async (client) => client.query<{ status: 'retrying' | 'dead'; attempts: number }>(
    `UPDATE events
        SET attempts = attempts + 1,
            last_error = $2, last_error_kind = $3, updated_at = now(),
            status = CASE WHEN $3 = 'permanent' OR attempts + 1 >= $4
                          THEN 'dead' ELSE 'retrying' END
      WHERE id = $1 AND status <> 'processed'
      RETURNING status, attempts`,
    [id, error instanceof Error ? error.message : String(error), kind, config.MAX_ATTEMPTS],
  ));

  if (result.rowCount === 0) {
    if (redisClient) await ackAndDelete(message, redisClient);
    return;
  }

  const row = result.rows[0];
  if (row.status === 'retrying') {
    if (!redisClient) throw new Error('Redis client is required for retry scheduling');
    const delay = computeBackoff(row.attempts, rng);
    await redisClient.zadd(DELAYED, String(now() + delay), id);
    await ackAndDelete(message, redisClient);
    eventsRetried.inc();
    return;
  }

  if (redisClient) await ackAndDelete(message, redisClient);
  eventsDead.inc({ reason: kind === 'permanent' ? 'permanent' : 'max_attempts' });
}
