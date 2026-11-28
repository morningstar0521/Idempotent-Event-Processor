import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { publishBatch } from '../../src/relay/relay.js';

const rows = [
  { id: '1', event_id: 'event-1', type: 'payment.captured' },
  { id: '2', event_id: 'event-2', type: 'payout.requested' },
];

function fakePoolClient() {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM outbox')) return { rowCount: rows.length, rows };
      return { rowCount: rows.length, rows: [] };
    },
  } as unknown as PoolClient;
  return { client, queries };
}

type ExecResult = [Error | null, unknown][] | null;

function fakeRedis(execResult?: (commands: unknown[][]) => ExecResult) {
  const directXadds: unknown[][] = [];
  const transactions: unknown[][][] = [];
  const redisClient = {
    xadd: async (...args: unknown[]) => {
      directXadds.push(args);
      return '1-0';
    },
    multi: () => {
      const commands: unknown[][] = [];
      const tx = {
        xadd: (...args: unknown[]) => {
          commands.push(args);
          return tx;
        },
        exec: async () => {
          transactions.push(commands);
          return execResult ? execResult(commands) : commands.map(() => [null, '1-0']);
        },
      };
      return tx;
    },
  } as never;
  return { redisClient, directXadds, transactions };
}

describe('relay fan-out', () => {
  it('U-FAN-1 uses the v1 single XADD path when the fan-out stream is unset', async () => {
    const { client, queries } = fakePoolClient();
    const redis = fakeRedis();
    expect(await publishBatch(client, redis.redisClient, 100, { stream: undefined, maxlen: 1000000 })).toBe(2);
    expect(redis.transactions).toEqual([]);
    expect(redis.directXadds).toEqual([
      ['events:stream', '*', 'event_id', 'event-1', 'type', 'payment.captured'],
      ['events:stream', '*', 'event_id', 'event-2', 'type', 'payout.requested'],
    ]);
    expect(queries.some((text) => text.startsWith('UPDATE outbox'))).toBe(true);
  });

  it('U-FAN-2 puts both XADDs in one MULTI per row when the fan-out stream is set', async () => {
    const { client } = fakePoolClient();
    const redis = fakeRedis();
    expect(await publishBatch(client, redis.redisClient, 100, { stream: 'events:fanout', maxlen: 5000 })).toBe(2);
    expect(redis.directXadds).toEqual([]);
    expect(redis.transactions).toEqual([
      [
        ['events:stream', '*', 'event_id', 'event-1', 'type', 'payment.captured'],
        ['events:fanout', 'MAXLEN', '~', '5000', '*', 'event_id', 'event-1', 'type', 'payment.captured'],
      ],
      [
        ['events:stream', '*', 'event_id', 'event-2', 'type', 'payout.requested'],
        ['events:fanout', 'MAXLEN', '~', '5000', '*', 'event_id', 'event-2', 'type', 'payout.requested'],
      ],
    ]);
  });

  it('U-FAN-3 fails the batch and leaves the outbox unpublished when one XADD in the MULTI errors', async () => {
    const { client, queries } = fakePoolClient();
    const redis = fakeRedis((commands) => commands.map((_, index) => [index === 1 ? new Error('WRONGTYPE') : null, '1-0']));
    await expect(publishBatch(client, redis.redisClient, 100, { stream: 'events:fanout', maxlen: 1000000 })).rejects.toThrow('WRONGTYPE');
    expect(queries.some((text) => text.startsWith('UPDATE outbox'))).toBe(false);
  });

  it('U-FAN-4 fails the batch when the MULTI is aborted', async () => {
    const { client, queries } = fakePoolClient();
    const redis = fakeRedis(() => null);
    await expect(publishBatch(client, redis.redisClient, 100, { stream: 'events:fanout', maxlen: 1000000 })).rejects.toThrow('fan-out MULTI');
    expect(queries.some((text) => text.startsWith('UPDATE outbox'))).toBe(false);
  });
});
