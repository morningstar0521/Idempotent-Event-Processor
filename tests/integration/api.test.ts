import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { closeTestResources, resetTestState, testQuery, testRedis, testWithTx } from './setup.js';

const apiKey = 'change-me';
const payment = {
  type: 'payment.captured',
  payload: { merchant_id: 'm_1', amount_minor: 50000, currency: 'INR', payment_id: 'p_1' }
};

let server: Server;
let baseUrl: string;

function headers(key = apiKey): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-API-Key': key };
}

async function post(key: string, body: unknown, api = baseUrl, apiKeyValue = apiKey): Promise<Response> {
  return fetch(`${api}/v1/events`, {
    method: 'POST',
    headers: { ...headers(apiKeyValue), 'Idempotency-Key': key },
    body: JSON.stringify(body)
  });
}

async function counts(): Promise<{ events: number; outbox: number }> {
  const result = await testQuery<{ events: string; outbox: string }>(
    `SELECT (SELECT count(*) FROM events)::text AS events, (SELECT count(*) FROM outbox)::text AS outbox`
  );
  return { events: Number(result.rows[0].events), outbox: Number(result.rows[0].outbox) };
}

async function listen(app = createApp({ queryFn: testQuery, withTxFn: testWithTx, redisClient: testRedis })): Promise<{ server: Server; url: string }> {
  const instance = app.listen(0);
  await new Promise<void>((resolve) => instance.once('listening', resolve));
  const address = instance.address() as AddressInfo;
  return { server: instance, url: `http://127.0.0.1:${address.port}` };
}

describe.sequential('Phase 1 API', () => {
  beforeAll(async () => {
    await resetTestState();
    const running = await listen();
    server = running.server;
    baseUrl = running.url;
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await resetTestState();
    await closeTestResources();
  });

  it('I-API-1 creates one event and one outbox row', async () => {
    const response = await post('api-1', payment);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'received', duplicate: false });
    expect(await counts()).toEqual({ events: 1, outbox: 1 });
  });

  it('I-API-2 returns the stored event for a duplicate', async () => {
    const first = await post('api-2', payment);
    const second = await post('api-2', payment);
    const firstBody = await first.json() as { event_id: string };
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ event_id: firstBody.event_id, duplicate: true });
    expect(await counts()).toEqual({ events: 1, outbox: 1 });
  });

  it('I-API-3 rejects the same key with a different body without changing the DB', async () => {
    await post('api-3', payment);
    const response = await post('api-3', { ...payment, payload: { ...payment.payload, amount_minor: 60000 } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await counts()).toEqual({ events: 1, outbox: 1 });
  });

  it('I-API-4 allows only one creator under 1,000 same-key requests', async () => {
    const responses = await Promise.all(Array.from({ length: 1000 }, () => post('api-4', payment)));
    const created = responses.filter((response) => response.status === 202).length;
    const duplicates = responses.filter((response) => response.status === 200).length;
    const failures = responses.filter((response) => response.status >= 400).length;
    const rows = await testQuery<{ events: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM events WHERE idempotency_key = $1)::text AS events,
         (SELECT count(*) FROM outbox WHERE event_id IN (SELECT id FROM events WHERE idempotency_key = $1))::text AS outbox`,
      ['api-4'],
    );
    console.log('I-API-4 concrete counts', {
      total_parallel_requests: responses.length,
      responses_202: created,
      responses_200_duplicate: duplicates,
      responses_4xx_5xx: failures,
      event_rows: Number(rows.rows[0].events),
      outbox_rows: Number(rows.rows[0].outbox),
    });
    expect(created).toBe(1);
    expect(duplicates).toBe(999);
    expect(failures).toBe(0);
    expect(Number(rows.rows[0].events)).toBe(1);
    expect(Number(rows.rows[0].outbox)).toBe(1);
    expect(await counts()).toEqual({ events: 1, outbox: 1 });
  }, 30000);

  it('I-API-5 creates one event per key under parallel distinct-key requests', async () => {
    const responses = await Promise.all(Array.from({ length: 200 }, (_, index) => post(`api-5-${index % 50}`, { ...payment, payload: { ...payment.payload, payment_id: `p-${index % 50}` } })));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(50);
    expect(await counts()).toEqual({ events: 50, outbox: 50 });
  });

  it('I-API-6 hashes equivalent JSON key orders equally', async () => {
    await post('api-6', payment);
    const response = await post('api-6', { payload: { payment_id: 'p_1', currency: 'INR', amount_minor: 50000, merchant_id: 'm_1' }, type: 'payment.captured' });
    expect(response.status).toBe(200);
  });

  it('I-API-7 rejects missing, empty, and overlong keys', async () => {
    for (const key of ['', 'a'.repeat(256)]) {
      const response = await fetch(`${baseUrl}/v1/events`, { method: 'POST', headers: { ...headers(), 'Idempotency-Key': key }, body: JSON.stringify(payment) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
    }
    const response = await fetch(`${baseUrl}/v1/events`, { method: 'POST', headers: headers(), body: JSON.stringify(payment) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
  });

  it('I-API-8 rejects invalid bodies with validation details', async () => {
    const response = await post('api-8', { ...payment, payload: { ...payment.payload, amount_minor: 0, extra: true } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: expect.any(Array) } });
  });

  it('I-API-9 protects v1 while leaving health public', async () => {
    const unauthorized = await post('api-9', payment, baseUrl, 'wrong');
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('I-API-10 rejects bodies over 10kb without storage', async () => {
    const response = await fetch(`${baseUrl}/v1/events`, { method: 'POST', headers: { ...headers(), 'Idempotency-Key': 'api-10' }, body: JSON.stringify({ ...payment, payload: { ...payment.payload, payment_id: 'x'.repeat(11000) } }) });
    expect([400, 413]).toContain(response.status);
    expect(await counts()).toEqual({ events: 0, outbox: 0 });
  });

  it('I-API-11 rolls back the event when outbox insertion fails', async () => {
    const failing = await listen(createApp({ failOutboxInsert: true, queryFn: testQuery, withTxFn: testWithTx, redisClient: testRedis }));
    try {
      const response = await post('api-11', payment, failing.url);
      expect(response.status).toBe(503);
      expect(await counts()).toEqual({ events: 0, outbox: 0 });
    } finally {
      await new Promise<void>((resolve, reject) => failing.server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('I-API-12 maps a closed database to UNAVAILABLE', async () => {
    const failing = await listen(createApp({
      queryFn: (async () => { throw new Error('connection refused'); }) as typeof testQuery,
      withTxFn: (async () => { throw new Error('connection refused'); }) as typeof testWithTx,
      redisClient: testRedis
    }));
    try {
      const response = await post('api-12', payment, failing.url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    } finally {
      await new Promise<void>((resolve, reject) => failing.server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('I-API-13 returns event metadata without payload and 404s unknown ids', async () => {
    const created = await post('api-13', payment);
    const eventId = (await created.json() as { event_id: string }).event_id;
    const response = await fetch(`${baseUrl}/v1/events/${eventId}`, { headers: { 'X-API-Key': apiKey } });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ event_id: eventId, type: 'payment.captured', status: 'received', attempts: 0 });
    expect(body).not.toHaveProperty('payload');
    const missing = await fetch(`${baseUrl}/v1/events/00000000-0000-0000-0000-000000000000`, { headers: { 'X-API-Key': apiKey } });
    expect(missing.status).toBe(404);
  });

  it('I-API-14 names the dependency that makes readiness fail', async () => {
    const redisDown = await listen(createApp({
      queryFn: testQuery,
      withTxFn: testWithTx,
      redisClient: { ping: async () => { throw new Error('redis unavailable'); } } as never,
    }));
    const postgresDown = await listen(createApp({
      queryFn: (async () => { throw new Error('postgres unavailable'); }) as typeof testQuery,
      withTxFn: testWithTx,
      redisClient: testRedis,
    }));
    try {
      const redisResponse = await fetch(`${redisDown.url}/ready`);
      expect(redisResponse.status).toBe(503);
      expect(await redisResponse.json()).toEqual({ status: 'not_ready', failing: 'redis' });
      const postgresResponse = await fetch(`${postgresDown.url}/ready`);
      expect(postgresResponse.status).toBe(503);
      expect(await postgresResponse.json()).toEqual({ status: 'not_ready', failing: 'postgres' });
    } finally {
      await Promise.all([redisDown.server, postgresDown.server].map((instance) => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()))));
    }
  });
});
