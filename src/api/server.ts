import express from 'express';
import type { Server } from 'node:http';
import type { Redis } from 'ioredis';
import { query } from '../shared/db.js';
import { metricsContent } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';
import { requireApiKey } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { requestLogging } from './middleware/request-logging.js';
import { registerEventRoutes, type EventRouteOptions } from './routes/events.js';

export function createApp(options: EventRouteOptions & { redisClient?: Redis } = {}) {
  const app = express();
  const queryFn = options.queryFn ?? query;
  const redisClient = options.redisClient ?? redis;
  app.use(requestLogging);
  app.use(express.json({ limit: '10kb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/ready', async (_request, response) => {
    const checks = await Promise.allSettled([queryFn('SELECT 1'), redisClient.ping()]);
    const postgres = checks[0].status === 'fulfilled';
    const redisReady = checks[1].status === 'fulfilled';
    if (postgres && redisReady) return response.json({ status: 'ready' });
    return response.status(503).json({ status: 'not_ready', postgres, redis: redisReady });
  });
  app.get('/metrics', async (_request, response) => {
    response.type('text/plain').send(await metricsContent());
  });
  const v1 = express.Router();
  v1.use(requireApiKey);
  registerEventRoutes(v1, options);
  app.use('/v1', v1);
  app.use(errorHandler);
  return app;
}

export function startServer(port: number): Server {
  return createApp().listen(port, () => console.log(`API listening on ${port}`));
}

