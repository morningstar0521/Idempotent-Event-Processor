import { Redis } from 'ioredis';
import { config } from './config.js';

export function createRedis(url = config.REDIS_URL): Redis {
  return new Redis(url);
}

export const redis = createRedis();

