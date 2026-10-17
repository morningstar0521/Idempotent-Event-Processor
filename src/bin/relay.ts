import express from 'express';
import { config } from '../shared/config.js';
import { metricsContent } from '../shared/metrics.js';
import { closeRelayResources, Relay } from '../relay/relay.js';
import { Sweeper } from '../relay/sweeper.js';

const metrics = express();
metrics.get('/metrics', async (_request, response) => {
  response.type('text/plain').send(await metricsContent());
});
const metricsServer = metrics.listen(config.METRICS_PORT, () => {
  console.log(`Relay metrics listening on ${config.METRICS_PORT}`);
});
const relay = new Relay();
const loop = relay.start();
const sweeper = new Sweeper();
sweeper.start();
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const finish = Promise.all([relay.stop(), sweeper.stop(), loop]);
  const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), config.SHUTDOWN_GRACE_MS));
  const result = await Promise.race([finish.then(() => 'finished' as const), grace]);
  await Promise.allSettled([
    new Promise<void>((resolve) => metricsServer.close(() => resolve())),
    closeRelayResources(),
  ]);
  process.exit(result === 'finished' ? 0 : 1);
}

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

