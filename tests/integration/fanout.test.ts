import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { configure, reset } from '../../src/shared/chaos.js';
import { pollOnce } from '../../src/relay/relay.js';
import { sweepOnce } from '../../src/relay/sweeper.js';
import { closeTestResources, resetTestState, testPool, testQuery, testRedis, testWithTx } from './setup.js';

const stream = 'events:stream';
const fanout = 'events:fanout';

async function seed(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const event = await testQuery<{ id: string }>(
      `INSERT INTO events (idempotency_key, type, payload, payload_hash)
       VALUES ($1, 'payment.captured', $2, $3) RETURNING id`,
      [`fanout-${index}`, JSON.stringify({ merchant_id: 'm_1', amount_minor: 1, currency: 'INR', payment_id: `p-${index}` }), `fanout-hash-${index}`],
    );
    await testQuery('INSERT INTO outbox (event_id) VALUES ($1)', [event.rows[0].id]);
  }
}

async function fields(key: string): Promise<string[][]> {
  const result = await testRedis.xrange(key, '-', '+');
  return result.map(([, values]) => values);
}

async function unpublished(): Promise<string> {
  return (await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL')).rows[0].count;
}

describe.sequential('relay fan-out', () => {
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

  it('I-FAN-1 publishes every event to both streams when the fan-out stream is set', async () => {
    await seed(200);
    let published = 0;
    while (published < 200) {
      published += await pollOnce({ redisClient: testRedis, withTxFn: testWithTx, batchSize: 50, fanoutStream: fanout });
    }
    expect(await unpublished()).toBe('0');
    expect(await testRedis.xlen(stream)).toBe(200);
    expect(await testRedis.xlen(fanout)).toBe(200);
    const ids = (await testQuery<{ event_id: string }>('SELECT event_id FROM outbox ORDER BY id')).rows.map((row) => row.event_id);
    expect((await fields(stream)).map((values) => values[1])).toEqual(ids);
    expect(await fields(fanout)).toEqual(await fields(stream));
  });

  it('I-FAN-2 does not create the fan-out stream when it is unset', async () => {
    await seed(50);
    let published = 0;
    while (published < 50) {
      published += await pollOnce({ redisClient: testRedis, withTxFn: testWithTx, batchSize: 20, fanoutStream: undefined });
    }
    expect(await testRedis.xlen(stream)).toBe(50);
    expect(await testRedis.exists(fanout)).toBe(0);
  });

  it('I-FAN-3 does not fan out sweeper re-deliveries', async () => {
    await testQuery(
      `INSERT INTO events (idempotency_key, type, payload, payload_hash, updated_at)
       VALUES ('fanout-sweep-1', 'payment.captured', '{}', 'fanout-sweep-hash-1', now() - interval '5 minutes')`,
    );
    expect(await sweepOnce({ redisClient: testRedis, poolClient: testPool })).toBe(1);
    expect(await testRedis.xlen(stream)).toBe(1);
    expect(await testRedis.exists(fanout)).toBe(0);
  });

  it('I-FAN-4 republishes to both streams after a crash following the MULTI (at-least-once)', async () => {
    await seed(1);
    process.env.CHAOS_ENABLED = 'true';
    configure({ crashAfterRelayXadd: true });
    await expect(pollOnce({ redisClient: testRedis, withTxFn: testWithTx, fanoutStream: fanout })).rejects.toThrow('simulated crash');
    expect(await unpublished()).toBe('1');
    expect(await testRedis.xlen(stream)).toBe(1);
    expect(await testRedis.xlen(fanout)).toBe(1);
    reset();
    process.env.CHAOS_ENABLED = 'false';
    await pollOnce({ redisClient: testRedis, withTxFn: testWithTx, fanoutStream: fanout });
    expect(await testRedis.xlen(stream)).toBe(2);
    expect(await testRedis.xlen(fanout)).toBe(2);
  });
});
