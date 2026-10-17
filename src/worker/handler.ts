import type { Redis } from 'ioredis';
import type { PoolClient } from 'pg';
import { applyEffect } from '../domain/effects.js';
import { PermanentError, TransientError } from '../domain/errors.js';
import { failBeforeEffect, crashBeforeCommit, crashAfterCommit, pause } from '../shared/chaos.js';
import { config } from '../shared/config.js';
import { pool, withTx } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { duplicatesBlocked, eventsProcessed, processingDuration } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';
import { release, startHeartbeat, tryAcquire } from './lock.js';
import { handleFailure, type FailureDependencies } from './retry.js';

const STREAM = 'events:stream';
const GROUP = 'workers';
const heldLocks = new Map<string, { key: string; token: string; redisClient: Redis }>();

export interface StreamMessage {
  id: string;
  event_id: string;
  type?: string;
}

export interface HandlerDependencies {
  redisClient?: Redis;
  withTxFn?: typeof withTx;
  tryAcquireFn?: typeof tryAcquire;
  startHeartbeatFn?: typeof startHeartbeat;
  releaseFn?: typeof release;
  handleFailureFn?: typeof handleFailure;
}

async function ackAndDelete(message: StreamMessage, redisClient: Redis): Promise<void> {
  await redisClient.xack(STREAM, GROUP, message.id);
  await redisClient.xdel(STREAM, message.id);
}

export async function processInTx(id: string, lostLock = () => false, withTxFn: typeof withTx = withTx): Promise<'applied' | 'skipped'> {
  return withTxFn(async (client: PoolClient) => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query<{ status: string; type: string; payload: unknown }>(
      'SELECT status, type, payload FROM events WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (result.rowCount !== 1) throw new PermanentError('EVENT_NOT_FOUND');
    const row = result.rows[0];
    if (row.status === 'processed' || row.status === 'dead') {
      duplicatesBlocked.inc({ layer: 'db_status' });
      return 'skipped';
    }
    await pause('inside_tx');
    failBeforeEffect();
    await applyEffect(client, row.type, row.payload, id);
    crashBeforeCommit();
    if (lostLock()) throw new TransientError('REDIS_LOCK_LOST');
    await client.query(
      `UPDATE events
       SET status = 'processed', processed_at = now(), updated_at = now(), attempts = attempts + 1
       WHERE id = $1`,
      [id],
    );
    return 'applied';
  });
}

export async function handle(msg: StreamMessage, dependencies: HandlerDependencies = {}): Promise<void> {
  const redisClient = dependencies.redisClient ?? redis;
  const acquire = dependencies.tryAcquireFn ?? ((key, ttl) => tryAcquire(key, ttl, redisClient));
  const heartbeat = dependencies.startHeartbeatFn ?? ((key, token, ttl) => startHeartbeat(key, token, ttl, redisClient));
  const releaseLock = dependencies.releaseFn ?? ((key, token) => release(key, token, redisClient));
  const fail = dependencies.handleFailureFn ?? handleFailure;
  const withTxFn = dependencies.withTxFn ?? withTx;
  const lock = await acquire(`lock:event:${msg.event_id}`, config.LOCK_TTL_MS);
  if (!lock) {
    duplicatesBlocked.inc({ layer: 'lock' });
    await ackAndDelete(msg, redisClient);
    return;
  }
  heldLocks.set(msg.id, { key: lock.key, token: lock.token, redisClient });

  const hb = heartbeat(lock.key, lock.token, config.LOCK_TTL_MS);
  const started = process.hrtime.bigint();
  let simulatedCrash = false;
  try {
    await pause('before_tx');
    const outcome = await processInTx(msg.event_id, () => hb.lostLock, withTxFn);
    await crashAfterCommit();
    await ackAndDelete(msg, redisClient);
    if (outcome === 'applied') eventsProcessed.inc();
  } catch (error) {
    if (error instanceof Error && error.name === 'SimulatedCrash') {
      simulatedCrash = true;
      throw error;
    }
    try {
      await fail(msg.event_id, error, msg, { redisClient, withTxFn } satisfies FailureDependencies);
    } catch (failureError) {
      logger.error({ err: failureError, event_id: msg.event_id }, 'event failure handling failed');
    }
  } finally {
    hb.stop();
    if (!simulatedCrash) await releaseLock(lock.key, lock.token);
    heldLocks.delete(msg.id);
    processingDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  }
}

export async function releaseHeldLocks(): Promise<void> {
  await Promise.all([...heldLocks.values()].map(({ key, token, redisClient }) => release(key, token, redisClient)));
  heldLocks.clear();
}

export async function closeHandlerResources(): Promise<void> {
  await pool.end();
}
