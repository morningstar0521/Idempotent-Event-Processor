import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPlan, writePlan, type LoadPlan } from './plan.js';
import { createRedis } from '../../src/shared/redis.js';
import { readFile } from 'node:fs/promises';

const exec = promisify(execFile);
const root = process.cwd();
const planPath = `${root}/scripts/load/plan.json`;
const scenario = process.env.LOAD_SCENARIO || 'dup_heavy';
const baseUrl = process.env.LOAD_BASE_URL || 'http://127.0.0.1:3000';
const apiKey = process.env.API_KEY || 'change-me';
const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/events';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const pool = new Pool({ connectionString: databaseUrl });

async function command(file: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const result = await exec(file, args, { cwd: root, env: { ...process.env, ...options.env }, maxBuffer: 20 * 1024 * 1024 });
  return result.stdout;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, path.startsWith('/v1/') ? { headers: { 'X-API-Key': apiKey } } : undefined);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function resetState(): Promise<void> {
  await pool.query('TRUNCATE outbox, events, wallets, ledger_entries RESTART IDENTITY CASCADE');
  const client = createRedis(redisUrl);
  await client.flushdb();
  await client.quit();
}

async function seedWallets(): Promise<void> {
  await Promise.all(Array.from({ length: 20 }, (_, index) => fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Idempotency-Key': `seed-${index}` },
    body: JSON.stringify({ type: 'payment.captured', payload: { merchant_id: `m_${index}`, amount_minor: 1_000_000, currency: 'INR', payment_id: `seed-${index}` } }),
  })));
  await waitForDrain(60000);
  for (let index = 0; index < 20; index += 1) {
    const wallet = await getJson(`/v1/wallets/m_${index}?verify=true`);
    if (wallet.verified !== true || wallet.balance_minor !== 1_000_000) throw new Error(`Seed verification failed for m_${index}`);
  }
}

async function waitForDrain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pending: string; unpublished: string }>(`SELECT
      (SELECT count(*) FROM events WHERE status IN ('received', 'retrying'))::text AS pending,
      (SELECT count(*) FROM outbox WHERE published_at IS NULL)::text AS unpublished`);
    if (result.rows[0].pending === '0' && result.rows[0].unpublished === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for load drain');
}

async function e2eLatency(plan: LoadPlan): Promise<{ p50: number; p95: number; p99: number }> {
  const keys = plan.scenario === 'same_key_storm' ? ['same-key-storm'] : plan.requests.map((request) => request.key).filter((key, index, all) => all.indexOf(key) === index);
  const result = await pool.query<{ p50: string; p95: string; p99: string }>(`SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000)::text AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000)::text AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000)::text AS p99
    FROM events WHERE idempotency_key = ANY($1::text[]) AND processed_at IS NOT NULL`, [keys]);
  return { p50: Number(result.rows[0].p50), p95: Number(result.rows[0].p95), p99: Number(result.rows[0].p99) };
}

async function scrape(url: string): Promise<string> {
  return (await command('docker', ['compose', 'exec', '-T', url.split(':')[0], 'node', '-e', `fetch('http://127.0.0.1:${url.split(':')[1]}/metrics').then(r=>r.text()).then(console.log)`])).trim();
}

async function snapshot(): Promise<Record<string, string[]>> {
  const workerIds = (await command('docker', ['compose', 'ps', '-q', 'worker'])).trim().split('\n').filter(Boolean);
  if (workerIds.length === 0) throw new Error('No worker containers found for metrics snapshot');
  const workers = await Promise.all(workerIds.map(async (id) => (await command('docker', ['exec', id, 'node', '-e', "fetch('http://127.0.0.1:9101/metrics').then(r=>r.text()).then(console.log)"])).trim()));
  return {
    api: [(await (await fetch(`${baseUrl}/metrics`)).text()).trim()],
    relay: [await scrape('relay:9102')],
    worker: workers,
  };
}

async function runK6(plan: LoadPlan): Promise<string> {
  const resultRelativePath = `scripts/load/results-${plan.run_id}.json`;
  const resultPath = `${root}/${resultRelativePath}`;
  const arrivalRate = Number(process.env.ARRIVAL_RATE || '25');
  const duration = process.env.DURATION || `${(plan.requests.length / arrivalRate).toFixed(3)}s`;
  const env = { SCENARIO: scenario, API_KEY: apiKey, BASE_URL: baseUrl, ARRIVAL_RATE: String(arrivalRate), DURATION: duration };
  const args = ['run', 'scripts/load/k6-ingest.js', `--env`, `SCENARIO=${env.SCENARIO}`, `--env`, `API_KEY=${env.API_KEY}`, `--env`, `BASE_URL=${env.BASE_URL}`, `--env`, `ARRIVAL_RATE=${env.ARRIVAL_RATE}`, `--env`, `DURATION=${env.DURATION}`, `--summary-export=${resultRelativePath}`];
  try {
    await command('k6', args);
  } catch {
    await command('docker', ['run', '--rm', '--add-host=host.docker.internal:host-gateway', '-v', `${root}:/work`, '-w', '/work', 'grafana/k6', 'run', 'scripts/load/k6-ingest.js', '--env', `SCENARIO=${scenario}`, '--env', `API_KEY=${apiKey}`, '--env', 'BASE_URL=http://host.docker.internal:3000', '--env', `ARRIVAL_RATE=${env.ARRIVAL_RATE}`, '--env', `DURATION=${env.DURATION}`, `--summary-export=${resultRelativePath}`]);
  }
  return resultPath;
}

async function main(): Promise<void> {
  await getJson('/ready');
  await resetState();
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const uniqueEvents = scenario === 'smoke' ? 10 : Number(process.env.UNIQUE_EVENTS || 500);
  const plan = createPlan(runId, uniqueEvents, 2, scenario);
  await writePlan(planPath, plan);
  await seedWallets();
  const before = await snapshot();
  const summaryPath = await runK6(plan);
  await waitForDrain(Number(process.env.DRAIN_TIMEOUT_MS || 120000));
  const after = await snapshot();
  const e2e = await e2eLatency(plan);
  const snapshotPath = `${root}/scripts/load/metrics-${runId}.json`;
  const invariantPath = `${root}/scripts/load/invariants-${runId}.json`;
  await writeFile(snapshotPath, JSON.stringify({ before, after, e2e }, null, 2));
  const expectedKeys = scenario === 'same_key_storm' ? 21 : plan.unique_events + 20;
  await command('pnpm', ['tsx', 'scripts/load/assert-invariants.ts', JSON.stringify(plan.expected_balances), String(expectedKeys), invariantPath], {
    env: { TEST_DATABASE_URL: databaseUrl, TEST_REDIS_URL: redisUrl },
  });
  const artifactsPath = `${root}/scripts/load/scenario-artifacts.json`;
  let artifacts: Record<string, { summary: string; snapshot: string }> = {};
  try { artifacts = JSON.parse(await readFile(artifactsPath, 'utf8')) as typeof artifacts; } catch { /* first scenario run */ }
  artifacts[scenario] = { summary: summaryPath, snapshot: snapshotPath };
  await writeFile(artifactsPath, JSON.stringify(artifacts, null, 2));
  await command('pnpm', ['tsx', 'scripts/report.ts', summaryPath, snapshotPath, planPath, invariantPath], { env: { LOAD_SCENARIO: scenario, ARRIVAL_RATE: process.env.ARRIVAL_RATE || '25' } });
  console.log(`LOAD_RUN_ID=${runId}`);
  console.log(`LOAD_SUMMARY=${summaryPath}`);
}

try {
  await main();
} finally {
  await pool.end();
}
