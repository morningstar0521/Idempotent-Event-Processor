import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { TransientError } from '../../src/domain/errors.js';
import { config } from '../../src/shared/config.js';
import { handle } from '../../src/worker/handler.js';
import { moveDue } from '../../src/worker/delayed.js';
import { handleFailure } from '../../src/worker/retry.js';
import { resetTestState, closeTestResources, testQuery, testRedis, testWithTx } from './setup.js';

const apiKey = 'change-me';
let server: Server;
let baseUrl: string;

async function insertEvent(type = 'payment.captured', payload: unknown = {
  merchant_id: 'retry-merchant', amount_minor: 10, currency: 'INR', payment_id: randomUUID(),
}): Promise<string> {
  const result = await testQuery<{ id: string }>(
    'INSERT INTO events (idempotency_key, type, payload, payload_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [randomUUID(), type, payload, randomUUID()],
  );
  return result.rows[0].id;
}

async function addMessage(eventId: string): Promise<{ id: string; event_id: string }> {
  const id = await testRedis.xadd('events:stream', '*', 'event_id', eventId, 'type', 'payment.captured');
  if (!id) throw new Error('missing stream id');
  return { id, event_id: eventId };
}

async function startApi(): Promise<void> {
  if (server) return;
  const app = createApp({ queryFn: testQuery, withTxFn: testWithTx, redisClient: testRedis });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function authHeaders(): HeadersInit {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
}

describe.sequential('Phase 4 retry, DLQ, and replay', () => {
  beforeEach(async () => {
    await resetTestState();
    try {
      await testRedis.xgroup('CREATE', 'events:stream', 'workers', '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeTestResources();
  });

  it('I-RTY-1 retries twice, schedules delays, then processes once', async () => {
    const eventId = await insertEvent();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await handleFailure(eventId, new TransientError('temporary'), await addMessage(eventId), {
        redisClient: testRedis, withTxFn: testWithTx, rng: () => 0, now: () => 0,
      });
      expect(await testRedis.zscore('events:delayed', eventId)).toBe('0');
      await moveDue(testRedis, 1);
    }
    await handle((await addMessage(eventId)), { redisClient: testRedis, withTxFn: testWithTx });
    const row = await testQuery<{ status: string; attempts: number }>('SELECT status, attempts FROM events WHERE id = $1', [eventId]);
    expect(row.rows[0]).toEqual({ status: 'processed', attempts: 3 });
    expect((await testQuery('SELECT 1 FROM ledger_entries WHERE event_id = $1', [eventId])).rowCount).toBe(1);
  });

  it('I-RTY-2 dead-letters after MAX_ATTEMPTS with no delayed retry', async () => {
    const eventId = await insertEvent();
    for (let attempt = 0; attempt < config.MAX_ATTEMPTS; attempt += 1) {
      await handleFailure(eventId, new TransientError('temporary'), await addMessage(eventId), {
        redisClient: testRedis, withTxFn: testWithTx, rng: () => 0, now: () => 0,
      });
      if (attempt < config.MAX_ATTEMPTS - 1) await moveDue(testRedis, 1);
    }
    const row = await testQuery<{ status: string; attempts: number; last_error_kind: string }>('SELECT status, attempts, last_error_kind FROM events WHERE id = $1', [eventId]);
    expect(row.rows[0]).toEqual({ status: 'dead', attempts: config.MAX_ATTEMPTS, last_error_kind: 'transient' });
    expect(await testRedis.zcard('events:delayed')).toBe(0);
  });

  it('I-RTY-3 moves only due ids once across concurrent movers', async () => {
    await testRedis.zadd('events:delayed', 10, 'due-1', 10, 'due-2', 20, 'future');
    const moved = await Promise.all([moveDue(testRedis, 10), moveDue(testRedis, 10), moveDue(testRedis, 10)]);
    expect(moved.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect((await testRedis.xrange('events:stream', '-', '+')).length).toBe(2);
    expect(await testRedis.zrange('events:delayed', 0, -1)).toEqual(['future']);
  });

  it('I-RTY-4 preserves the retry when XACK fails after ZADD', async () => {
    const eventId = await insertEvent();
    const message = await addMessage(eventId);
    const failingRedis = Object.create(testRedis) as typeof testRedis;
    failingRedis.xack = async () => { throw new Error('crash between ZADD and XACK'); };
    await expect(handleFailure(eventId, new TransientError('temporary'), message, {
      redisClient: failingRedis, withTxFn: testWithTx, rng: () => 0, now: () => 0,
    })).rejects.toThrow('crash between ZADD and XACK');
    expect(await testRedis.zscore('events:delayed', eventId)).toBe('0');
    await moveDue(testRedis, 1);
    await handle(message, { redisClient: testRedis, withTxFn: testWithTx });
    const retryMessage = (await testRedis.xreadgroup('GROUP', 'workers', 'retry-test', 'COUNT', '1', 'STREAMS', 'events:stream', '>') as Array<[string, Array<[string, string[]]>]>)[0][1][0];
    await handle({ id: retryMessage[0], event_id: eventId }, { redisClient: testRedis, withTxFn: testWithTx });
    expect((await testQuery('SELECT 1 FROM ledger_entries WHERE event_id = $1', [eventId])).rowCount).toBe(1);
  });

  it('I-RTY-5 does not acknowledge when Postgres is unavailable', async () => {
    const eventId = await insertEvent();
    const message = await addMessage(eventId);
    const acked: string[] = [];
    const redisClient = Object.create(testRedis) as typeof testRedis;
    redisClient.xack = async () => { acked.push('ack'); return 1; };
    await expect(handleFailure(eventId, new TransientError('temporary'), message, {
      redisClient, withTxFn: async () => { throw new Error('postgres down'); },
    })).rejects.toThrow('postgres down');
    expect(acked).toEqual([]);
  });

  it('I-RTY-6 lists only dead events with capped paging', async () => {
    await startApi();
    const first = await insertEvent();
    const second = await insertEvent();
    await testQuery("UPDATE events SET status = 'dead', attempts = 1, last_error = 'bad', last_error_kind = 'permanent', updated_at = now() WHERE id = ANY($1::uuid[])", [[first, second]]);
    const response = await fetch(`${baseUrl}/v1/dlq?limit=201`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ event_id: string }>; next_before: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item) => item.event_id)).toContain(first);
    expect(body.next_before).toBeNull();
  });

  it('I-RTY-7 replays a dead event after its cause is fixed', async () => {
    await startApi();
    const eventId = await insertEvent();
    await testQuery("UPDATE events SET status = 'dead', attempts = 1 WHERE id = $1", [eventId]);
    const response = await fetch(`${baseUrl}/v1/dlq/${eventId}/replay`, { method: 'POST', headers: authHeaders() });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ event_id: eventId, status: 'retrying' });
    const row = await testQuery<{ status: string; attempts: number }>('SELECT status, attempts FROM events WHERE id = $1', [eventId]);
    expect(row.rows[0]).toEqual({ status: 'retrying', attempts: 0 });
  });

  it('I-RTY-8 allows only one parallel replay', async () => {
    await startApi();
    const eventId = await insertEvent();
    await testQuery("UPDATE events SET status = 'dead' WHERE id = $1", [eventId]);
    const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${baseUrl}/v1/dlq/${eventId}/replay`, { method: 'POST', headers: authHeaders() })));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    expect((await testRedis.xrange('events:stream', '-', '+')).length).toBe(1);
  });

  it('I-RTY-9 rejects replay for processed and unknown events', async () => {
    await startApi();
    const eventId = await insertEvent();
    await testQuery("UPDATE events SET status = 'processed' WHERE id = $1", [eventId]);
    for (const id of [eventId, randomUUID()]) {
      const response = await fetch(`${baseUrl}/v1/dlq/${id}/replay`, { method: 'POST', headers: authHeaders() });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_REPLAYABLE' } });
    }
  });
});
