import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { delayedSize } from '../shared/metrics.js';

const DELAYED = 'events:delayed';
const STREAM = 'events:stream';
const MOVE_DUE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(due) do
  redis.call('XADD', KEYS[2], '*', 'event_id', id)
  redis.call('ZREM', KEYS[1], id)
end
return #due`;

export async function moveDue(redisClient: Redis, now = Date.now(), batchLimit = 100): Promise<number> {
  const moved = Number(await redisClient.eval(MOVE_DUE_SCRIPT, 2, DELAYED, STREAM, String(now), String(batchLimit)));
  delayedSize.set(await redisClient.zcard(DELAYED));
  logger.debug({ moved }, 'delayed events moved');
  return moved;
}

export function startDelayedMover(redisClient: Redis): NodeJS.Timeout {
  return globalThis.setInterval(() => {
    void moveDue(redisClient).catch((error) => logger.error({ err: error }, 'delayed mover failed'));
  }, 500);
}
