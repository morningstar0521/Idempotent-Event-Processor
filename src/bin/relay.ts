import express from 'express';
import { config } from '../shared/config.js';
import { metricsContent } from '../shared/metrics.js';
import { closeRelayResources, Relay } from '../relay/relay.js';

const metrics = express();
metrics.get('/metrics', async (_request, response) => {
  response.type('text/plain').send(await metricsContent());
});
const metricsServer = metrics.listen(config.METRICS_PORT, () => {
  console.log(`Relay metrics listening on ${config.METRICS_PORT}`);
});
const relay = new Relay();
const loop = relay.start();
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await relay.stop();
  await new Promise<void>((resolve, reject) => metricsServer.close((error) => error ? reject(error) : resolve()));
  await closeRelayResources();
  await loop;
  process.exit(0);
}

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

