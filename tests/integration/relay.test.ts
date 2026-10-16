import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { configure, reset } from '../../src/shared/chaos.js';
import { pollOnce } from '../../src/relay/relay.js';
import { closeTestResources, resetTestState, testQuery, testRedis, testWithTx } from './setup.js';

const stream = 'events:stream';

async function seed(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const event = await testQuery<{ id: string }>(
      `INSERT INTO events (idempotency_key, type, payload, payload_hash)
       VALUES ($1, 'payment.captured', $2, $3) RETURNING id`,
      [`relay-${index}`, JSON.stringify({ merchant_id: 'm_1', amount_minor: 1, currency: 'INR', payment_id: `p-${index}` }), `hash-${index}`],
    );
    await testQuery('INSERT INTO outbox (event_id) VALUES ($1)', [event.rows[0].id]);
  }
}

async function fields(): Promise<string[][]> {
  const result = await testRedis.xrange(stream, '-', '+');
  return result.map(([, values]) => values);
}

describe.sequential('relay', () => {
  beforeEach(async () => {
    reset();
    process.env.CHAOS_ENABLED = 'false';
    await resetTestState();
  });

  afterAll(async () => {
    reset();
    process.env.CHAOS_ENABLED = 'false';
    await resetTestState();
    await closeTestResources();
  });

  it('I-REL-1 publishes 500 rows in outbox order', async () => {
    await seed(500);
    let published = 0;
    while (published < 500) published += await pollOnce({ redisClient: testRedis, withTxFn: testWithTx, batchSize: 100 });
    expect((await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL')).rows[0].count).toBe('0');
    expect(await testRedis.xlen(stream)).toBe(500);
    const ids = await testQuery<{ event_id: string }>('SELECT event_id FROM outbox ORDER BY id');
    const messages = await fields();
    expect(messages.map((values) => values[1])).toEqual(ids.rows.map((row) => row.event_id));
  });

  it('I-REL-2 lets three relays publish 500 rows without duplicates', async () => {
    await seed(500);
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (true) {
        const count = await pollOnce({ redisClient: testRedis, withTxFn: testWithTx, batchSize: 20 });
        const remaining = await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL');
        if (remaining.rows[0].count === '0') return;
        if (count === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }));
    expect(await testRedis.xlen(stream)).toBe(500);
    expect((await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL')).rows[0].count).toBe('0');
  });

  it('I-REL-3 rolls back after XADD and republishes on the next relay', async () => {
    await seed(1);
    process.env.CHAOS_ENABLED = 'true';
    configure({ crashAfterRelayXadd: true });
    await expect(pollOnce({ redisClient: testRedis, withTxFn: testWithTx })).rejects.toThrow('simulated crash');
    expect((await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL')).rows[0].count).toBe('1');
    expect(await testRedis.xlen(stream)).toBe(1);
    reset();
    process.env.CHAOS_ENABLED = 'false';
    await pollOnce({ redisClient: testRedis, withTxFn: testWithTx });
    expect(await testRedis.xlen(stream)).toBe(2);
  });

  it('I-REL-4 publishes only event_id and type fields', async () => {
    await seed(1);
    await pollOnce({ redisClient: testRedis, withTxFn: testWithTx });
    const values = (await fields())[0];
    expect(values).toHaveLength(4);
    expect(values[0]).toBe('event_id');
    expect(values[2]).toBe('type');
    expect(values).not.toContain('payload');
  });
});
