import express from 'express';
import { config } from '../shared/config.js';
import { metricsContent } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';
import { pool } from '../shared/db.js';
import { Worker } from '../worker/worker.js';

const metrics = express();
metrics.get('/metrics', async (_request, response) => {
  response.type('text/plain').send(await metricsContent());
});
const metricsServer = metrics.listen(config.METRICS_PORT, () => {
  console.log(`Worker metrics listening on ${config.METRICS_PORT}`);
});
const worker = new Worker();
const loop = worker.start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), config.SHUTDOWN_GRACE_MS));
  const finished = worker.stop().then(() => 'finished' as const);
  const result = await Promise.race([finished, grace]);
  if (result === 'grace') {
    process.exitCode = 1;
  } else {
    await loop;
    await new Promise<void>((resolve, reject) => metricsServer.close((error) => error ? reject(error) : resolve()));
    await Promise.all([pool.end(), redis.quit()]);
    process.exitCode = 0;
  }
  process.exit();
}

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

