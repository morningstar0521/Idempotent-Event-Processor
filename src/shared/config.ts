import { z } from 'zod';

const booleanEnv = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  METRICS_PORT: z.coerce.number().int().positive().default(9101),
  API_KEY: z.string().min(1).default('change-me'),
  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/events'),
  TEST_DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/events_test'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  TEST_REDIS_URL: z.string().url().default('redis://localhost:6379/15'),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(500),
  BACKOFF_CAP_MS: z.coerce.number().int().positive().default(30000),
  LOCK_TTL_MS: z.coerce.number().int().positive().default(30000),
  VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MAX_DELIVERIES: z.coerce.number().int().positive().default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  RELAY_BATCH: z.coerce.number().int().positive().default(100),
  RELAY_POLL_MS: z.coerce.number().int().positive().default(100),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  SWEEP_STALE_MS: z.coerce.number().int().positive().default(120000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(15000),
  CHAOS_ENABLED: booleanEnv,
  CHAOS_FAIL_PROB: z.coerce.number().min(0).max(1).default(0),
  CHAOS_CRASH_BEFORE_COMMIT_PROB: z.coerce.number().min(0).max(1).default(0),
  CHAOS_CRASH_AFTER_COMMIT_PROB: z.coerce.number().min(0).max(1).default(0),
  CHAOS_DISABLE_HEARTBEAT: booleanEnv,
  CHAOS_PAUSE_MS: z.coerce.number().int().nonnegative().default(0)
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }
  if (result.data.NODE_ENV === 'production' && result.data.CHAOS_ENABLED) {
    throw new Error('CHAOS_ENABLED cannot be true in production');
  }
  return result.data;
}

export const config = loadConfig();

