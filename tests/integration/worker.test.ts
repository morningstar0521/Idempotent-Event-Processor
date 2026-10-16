import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { applyEffect } from '../../src/domain/effects.js';
import { handle } from '../../src/worker/handler.js';
import { release, startHeartbeat, tryAcquire } from '../../src/worker/lock.js';
import { testQuery, testRedis, testWithTx, resetTestState } from './setup.js';

const payment = (merchant_id = 'm_1', amount_minor = 50000) => ({ merchant_id, amount_minor, currency: 'INR', payment_id: randomUUID() });

async function insertEvent(type: string, payload: unknown): Promise<string> {
  const result = await testQuery<{ id: string }>(
    'INSERT INTO events (idempotency_key, type, payload, payload_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [randomUUID(), type, payload, randomUUID()],
  );
  return result.rows[0].id;
}

async function message(eventId: string): Promise<{ id: string; event_id: string }> {
  const id = await testRedis.xadd('events:stream', '*', 'event_id', eventId, 'type', 'payment.captured');
  if (!id) throw new Error('Redis did not return a stream id');
  return { id, event_id: eventId };
}

const deps = { redisClient: testRedis, withTxFn: testWithTx };

describe('worker', () => {
  beforeEach(async () => {
    await resetTestState();
    try {
      await testRedis.xgroup('CREATE', 'events:stream', 'workers', '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
  });

  it('I-WRK-1 processes a captured payment and acknowledges its message', async () => {
    const eventId = await insertEvent('payment.captured', payment());
    const msg = await message(eventId);
    await handle(msg, deps);
    const event = await testQuery<{ status: string }>('SELECT status FROM events WHERE id = $1', [eventId]);
    const ledger = await testQuery('SELECT 1 FROM ledger_entries WHERE event_id = $1', [eventId]);
    expect(event.rows[0].status).toBe('processed');
    expect(ledger.rowCount).toBe(1);
    expect(await testRedis.xrange('events:stream', '-', '+')).toHaveLength(0);
  });

  it('I-WRK-2 debits a funded wallet for a payout', async () => {
    const payload = payment();
    await testQuery('INSERT INTO wallets (merchant_id, balance_minor) VALUES ($1, $2)', [payload.merchant_id, payload.amount_minor]);
    const eventId = await insertEvent('payout.requested', { merchant_id: payload.merchant_id, amount_minor: payload.amount_minor, currency: payload.currency, payout_id: payload.payment_id });
    await handle(await message(eventId), deps);
    const wallet = await testQuery<{ balance_minor: string }>('SELECT balance_minor FROM wallets WHERE merchant_id = $1', [payload.merchant_id]);
    const ledger = await testQuery<{ amount_minor: string }>('SELECT amount_minor FROM ledger_entries WHERE event_id = $1', [eventId]);
    expect(wallet.rows[0].balance_minor).toBe('0');
    expect(ledger.rows[0].amount_minor).toBe(`-${payload.amount_minor}`);
  });

  it('I-WRK-3 applies one effect for twenty duplicate deliveries', async () => {
    const eventId = await insertEvent('payment.captured', payment());
    const messages = await Promise.all(Array.from({ length: 20 }, () => message(eventId)));
    await Promise.all(messages.map((msg) => handle(msg, deps)));
    expect((await testQuery('SELECT 1 FROM ledger_entries WHERE event_id = $1', [eventId])).rowCount).toBe(1);
    expect((await testQuery<{ balance_minor: string }>('SELECT balance_minor FROM wallets WHERE merchant_id = $1', ['m_1'])).rows[0].balance_minor).toBe('50000');
  });

  it('I-WRK-4 skips a processed event and acknowledges the duplicate', async () => {
    const eventId = await insertEvent('payment.captured', payment());
    await testQuery("UPDATE events SET status = 'processed' WHERE id = $1", [eventId]);
    await handle(await message(eventId), deps);
    expect(await testRedis.xrange('events:stream', '-', '+')).toHaveLength(0);
  });

  it('I-WRK-5 protects a second direct effect with the ledger constraint', async () => {
    const eventId = await insertEvent('payment.captured', payment());
    const payload = payment();
    await testWithTx((client) => applyEffect(client, 'payment.captured', payload, eventId));
    await testWithTx((client) => applyEffect(client, 'payment.captured', payload, eventId));
    expect((await testQuery('SELECT 1 FROM ledger_entries WHERE event_id = $1', [eventId])).rowCount).toBe(1);
  });

  it('I-WRK-7 rolls back an effect when the transaction fails after the wallet update', async () => {
    await testWithTx(async (client) => {
      await client.query('INSERT INTO wallets (merchant_id, balance_minor) VALUES ($1, $2)', ['m_1', 0]);
    });
    await expect(testWithTx(async (client) => {
      await client.query('UPDATE wallets SET balance_minor = 100 WHERE merchant_id = $1', ['m_1']);
      throw new Error('forced failure');
    })).rejects.toThrow('forced failure');
    expect((await testQuery<{ balance_minor: string }>('SELECT balance_minor FROM wallets WHERE merchant_id = $1', ['m_1'])).rows[0].balance_minor).toBe('0');
  });

  it('I-WRK-10 releases only the lock owner and always sets a TTL', async () => {
    const key = `test-lock:${randomUUID()}`;
    const first = await tryAcquire(key, 1000, testRedis);
    expect(first).not.toBeNull();
    expect(await tryAcquire(key, 1000, testRedis)).toBeNull();
    await release(key, 'wrong-token', testRedis);
    expect(await testRedis.exists(key)).toBe(1);
    expect(await testRedis.pttl(key)).toBeGreaterThan(0);
    await release(key, first!.token, testRedis);
    expect(await testRedis.exists(key)).toBe(0);
  });

  it('I-WRK-11 renews a lock while the heartbeat is active', async () => {
    const key = `test-heartbeat:${randomUUID()}`;
    const lock = await tryAcquire(key, 100, testRedis);
    const heartbeat = startHeartbeat(key, lock!.token, 100, testRedis);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(await testRedis.exists(key)).toBe(1);
    heartbeat.stop();
    await release(key, lock!.token, testRedis);
  });
});
