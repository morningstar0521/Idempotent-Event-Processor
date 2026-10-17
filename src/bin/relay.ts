import express from 'express';
import { config } from '../shared/config.js';
import { metricsContent } from '../shared/metrics.js';
import { logger } from '../shared/logger.js';
import { closeRelayResources } from '../relay/relay.js';
import { createRelayRuntime } from './factories.js';

const metrics = express();
metrics.get('/metrics', async (_request, response) => {
  response.type('text/plain').send(await metricsContent());
});
const metricsServer = metrics.listen(config.METRICS_PORT, () => {
  console.log(`Relay metrics listening on ${config.METRICS_PORT}`);
});
const { relay, sweeper, loop } = createRelayRuntime();
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
  const exitCode = result === 'finished' ? 0 : 1;
  logger.info({ service: 'relay', exit_code: exitCode }, 'shutdown complete');
  process.exit(exitCode);
}

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

