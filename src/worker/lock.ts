import { randomBytes } from 'node:crypto';
import { clearInterval, setInterval } from 'node:timers';
import type { Redis } from 'ioredis';
import { config } from '../shared/config.js';
import { redis } from '../shared/redis.js';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export interface EventLock {
  key: string;
  token: string;
}

export interface Heartbeat {
  stop(): void;
  readonly lostLock: boolean;
}

export async function tryAcquire(key: string, ttlMs: number, redisClient: Redis = redis): Promise<EventLock | null> {
  const token = randomBytes(32).toString('hex');
  const acquired = await redisClient.set(key, token, 'PX', ttlMs, 'NX');
  return acquired === 'OK' ? { key, token } : null;
}

export async function release(key: string, token: string, redisClient: Redis = redis): Promise<void> {
  await redisClient.eval(RELEASE_SCRIPT, 1, key, token);
}

export function startHeartbeat(key: string, token: string, ttlMs: number, redisClient: Redis = redis): Heartbeat {
  let lost = false;
  let stopped = false;
  if (config.CHAOS_DISABLE_HEARTBEAT) {
    return { stop: () => { stopped = true; }, get lostLock() { return lost; } };
  }
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await redisClient.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
      if (Number(result) !== 1) lost = true;
    } catch {
      lost = true;
    }
  };
  const timer = setInterval(() => void renew(), Math.max(1, Math.floor(ttlMs / 3)));
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    get lostLock() {
      return lost;
    }
  };
}

export const lockTtlMs = config.LOCK_TTL_MS;
