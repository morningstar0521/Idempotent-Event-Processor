import express from 'express';
import type { Server } from 'node:http';
import { query } from '../shared/db.js';
import { metricsContent } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';

export function createApp() {
  const app = express();
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/ready', async (_request, response) => {
    const checks = await Promise.allSettled([query('SELECT 1'), redis.ping()]);
    const postgres = checks[0].status === 'fulfilled';
    const redisReady = checks[1].status === 'fulfilled';
    if (postgres && redisReady) return response.json({ status: 'ready' });
    return response.status(503).json({ status: 'not_ready', postgres, redis: redisReady });
  });
  app.get('/metrics', async (_request, response) => {
    response.type('text/plain').send(await metricsContent());
  });
  return app;
}

export function startServer(port: number): Server {
  return createApp().listen(port, () => console.log(`API listening on ${port}`));
}

