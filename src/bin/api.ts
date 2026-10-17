import { config } from '../shared/config.js';
import { pool } from '../shared/db.js';
import { redis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { startServer } from '../api/server.js';

const server = startServer(config.PORT);
let stopping = false;

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), config.SHUTDOWN_GRACE_MS));
  const finished = closeServer().then(() => 'finished' as const);
  const result = await Promise.race([finished, grace]);
  await Promise.allSettled([pool.end(), redis.quit()]);
  const exitCode = result === 'finished' ? 0 : 1;
  logger.info({ service: 'api', exit_code: exitCode }, 'shutdown complete');
  process.exit(exitCode);
}

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

