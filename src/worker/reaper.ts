import type { Redis } from 'ioredis';
import { config } from '../shared/config.js';
import { query } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { eventsDead, messagesReclaimed } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';
import { handle, type StreamMessage } from './handler.js';

const STREAM = 'events:stream';
const GROUP = 'workers';

export interface ReaperDependencies {
  redisClient?: Redis;
  handleFn?: typeof handle;
  queryFn?: typeof query;
  consumerName: string;
}

function messageFromFields(id: string, fields: string[]): StreamMessage {
  const eventIndex = fields.indexOf('event_id');
  return { id, event_id: fields[eventIndex + 1] };
}

async function deliveryCount(redisClient: Redis, id: string): Promise<number> {
  const result = await redisClient.xpending(STREAM, GROUP, id, id, 1) as Array<[string, string, number, number]>;
  return Number(result[0]?.[3] ?? 0);
}

async function deadLetter(
  message: StreamMessage,
  redisClient: Redis,
  queryFn: typeof query,
): Promise<void> {
  const result = await queryFn(
    `UPDATE events
        SET status = 'dead', last_error = 'max deliveries exceeded',
            last_error_kind = 'permanent', updated_at = now()
      WHERE id = $1 AND status <> 'processed'`,
    [message.event_id],
  );
  if (result.rowCount === 1) eventsDead.inc({ reason: 'max_deliveries' });
  await redisClient.xack(STREAM, GROUP, message.id);
  await redisClient.xdel(STREAM, message.id);
}

async function removeTerminalMessage(
  message: StreamMessage,
  redisClient: Redis,
  queryFn: typeof query,
): Promise<void> {
  const result = await queryFn('SELECT status FROM events WHERE id = $1', [message.event_id]);
  const status = result.rows[0]?.status;
  if (status === 'processed' || status === 'dead') {
    await redisClient.xack(STREAM, GROUP, message.id);
    await redisClient.xdel(STREAM, message.id);
  }
}

async function claimPending(
  redisClient: Redis,
  consumerName: string,
): Promise<Array<[string, string[]]>> {
  const pending = await redisClient.xpending(STREAM, GROUP, '-', '+', 50) as Array<[string, string, number, number]>;
  const ids = pending
    .filter(([, , idle]) => idle >= config.VISIBILITY_TIMEOUT_MS)
    .map(([id]) => id);
  if (ids.length === 0) return [];
  return await redisClient.xclaim(STREAM, GROUP, consumerName, config.VISIBILITY_TIMEOUT_MS, ...ids) as Array<[string, string[]]>;
}

export async function reclaimOnce(dependencies: ReaperDependencies): Promise<number> {
  const redisClient = dependencies.redisClient ?? redis;
  const handleFn = dependencies.handleFn ?? handle;
  const queryFn = dependencies.queryFn ?? query;
  const claimed = await redisClient.xautoclaim(
    STREAM,
    GROUP,
    dependencies.consumerName,
    config.VISIBILITY_TIMEOUT_MS,
    '0-0',
    'COUNT',
    50,
  ) as [string, Array<[string, string[]]>, string[]];
  const messages = claimed[1]?.length > 0
    ? claimed[1]
    : await claimPending(redisClient, dependencies.consumerName);
  await Promise.all(messages.map(async ([id, fields]) => {
    const message = messageFromFields(id, fields);
    messagesReclaimed.inc();
    try {
      const count = await deliveryCount(redisClient, id);
      if (count >= config.MAX_DELIVERIES) {
        await deadLetter(message, redisClient, queryFn);
        return;
      }
      await handleFn(message);
      await removeTerminalMessage(message, redisClient, queryFn);
    } catch (error) {
      logger.error({ err: error, event_id: message.event_id, msg_id: message.id }, 'reaper message handling failed');
    }
  }));
  return messages.length;
}

export class Reaper {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;

  constructor(private readonly dependencies: ReaperDependencies) {}

  start(): void {
    this.timer = globalThis.setInterval(() => {
      if (this.current) return;
      this.current = reclaimOnce(this.dependencies)
        .then(() => undefined)
        .catch((error) => {
          if (!(error instanceof Error && error.message.includes('NOGROUP'))) logger.error({ err: error }, 'reaper cycle failed');
        })
        .finally(() => { this.current = undefined; });
    }, Math.max(100, Math.floor(config.VISIBILITY_TIMEOUT_MS / 2)));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) globalThis.clearInterval(this.timer);
    await this.current;
  }
}
