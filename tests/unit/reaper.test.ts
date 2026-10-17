import { describe, expect, it } from 'vitest';
import { reclaimOnce } from '../../src/worker/reaper.js';

describe('reaper', () => {
  it('I-RPR-2 dead-letters a message over the delivery cap', async () => {
    const calls: string[] = [];
    const redis = {
      xautoclaim: async () => ['0-0', [['1-0', ['event_id', 'event-1', 'type', 'payment.captured']]], []],
      xpending: async () => [['1-0', 'worker', 40000, 11]],
      xack: async () => { calls.push('ack'); return 1; },
      xdel: async () => { calls.push('delete'); return 1; },
    } as never;
    const updates: unknown[][] = [];
    await reclaimOnce({
      redisClient: redis,
      consumerName: 'reaper',
      queryFn: (async (_sql: string, values: unknown[]) => {
        updates.push(values);
        return { rowCount: 1, rows: [] };
      }) as never,
      handleFn: async () => { throw new Error('should not handle poison message'); },
    });
    expect(updates).toEqual([['event-1']]);
    expect(calls).toEqual(['ack', 'delete']);
  });

  it('I-RPR-1 sends a reclaimed message through the normal handler', async () => {
    let handled = false;
    const redis = {
      xautoclaim: async () => ['0-0', [['2-0', ['event_id', 'event-2']]], []],
      xpending: async () => [['2-0', 'worker', 40000, 2]],
    } as never;
    await reclaimOnce({
      redisClient: redis,
      consumerName: 'reaper',
      handleFn: async (message) => { handled = message.event_id === 'event-2'; },
    });
    expect(handled).toBe(true);
  });
});
