import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { handle } from '../../src/worker/handler.js';

function fakeRedis(order: string[]): Redis {
  return {
    xack: async () => { order.push('ack'); return 1; },
    xdel: async () => { order.push('delete'); return 1; },
  } as unknown as Redis;
}

const event = {
  id: 'event-1',
  event_id: 'event-1',
  type: 'payment.captured',
};

describe('worker ack ordering', () => {
  it('I-WRK-9 never acknowledges before commit on success', async () => {
    const order: string[] = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes('SELECT status')) return { rowCount: 1, rows: [{ status: 'received', type: 'payment.captured', payload: { merchant_id: 'm_1', amount_minor: 10, currency: 'INR', payment_id: 'p_1' } }] };
        if (sql.includes('ledger_entries')) return { rowCount: 1, rows: [{ id: 1 }] };
        return { rowCount: 1, rows: [] };
      },
    };
    const withTxFn = async (fn: (value: typeof client) => Promise<'applied' | 'skipped'>) => {
      const result = await fn(client);
      order.push('commit');
      return result;
    };
    await handle(event, {
      redisClient: fakeRedis(order),
      withTxFn: withTxFn as never,
      tryAcquireFn: async () => ({ key: 'lock:event-1', token: 'token' }),
      startHeartbeatFn: () => ({ stop: () => undefined, lostLock: false }),
      releaseFn: async () => undefined,
    });
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('ack'));
  });

  it('I-WRK-9 leaves a failed delivery unacknowledged', async () => {
    const order: string[] = [];
    await handle(event, {
      redisClient: fakeRedis(order),
      withTxFn: async () => { throw new Error('database unavailable'); },
      tryAcquireFn: async () => ({ key: 'lock:event-1', token: 'token' }),
      startHeartbeatFn: () => ({ stop: () => undefined, lostLock: false }),
      releaseFn: async () => undefined,
    });
    expect(order).not.toContain('ack');
  });
});
