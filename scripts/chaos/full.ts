import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

type Counts = { unique: number; processed: number; dead: number; lost: number; duplicateEffects: number };
type Result = Counts & { id: string; status: 'PASS' | 'FAIL'; recovery_ms: number | null; invariants: boolean };
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/events' });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const results: Result[] = [];
const api = 'http://127.0.0.1:3000/v1/events';
pool.on('error', () => undefined);
redis.on('error', () => undefined);

function compose(args: string[]): string { return execFileSync('docker', ['compose', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function reset(): Promise<void> {
  await pool.query('TRUNCATE outbox, events, wallets, ledger_entries RESTART IDENTITY CASCADE');
  await redis.flushall();
  await pool.query("INSERT INTO wallets (merchant_id, balance_minor) SELECT 'm_' || i, 1000000 FROM generate_series(0, 19) AS i");
}
async function post(key: string, index: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'change-me', 'Idempotency-Key': key }, body: JSON.stringify({ type: 'payment.captured', payload: { merchant_id: `m_${index % 20}`, amount_minor: 100 + (index % 900), currency: 'INR', payment_id: key } }) });
      if (response.status === 200 || response.status === 202) return;
    } catch { /* restart windows are retried with the same idempotency key */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`request failed after retries: ${key}`);
}
function workerIds(): string[] { return compose(['ps', '-q', 'worker']).split('\n').filter(Boolean); }
function killWorker(): void { const ids = workerIds(); const worker = ids[Math.floor(Math.random() * ids.length)]; if (worker) execFileSync('docker', ['kill', '-s', 'KILL', worker], { stdio: 'pipe' }); }
async function load(action: () => Promise<void>): Promise<void> {
  const requests = Array.from({ length: 750 }, (_, index) => index < 500 ? index : index - 500);
  for (let offset = 0; offset < requests.length; offset += 50) {
    await Promise.all(requests.slice(offset, offset + 50).map((index) => post(`cf-${index}`, index)));
    if (offset === 350) await action();
  }
}
async function waitForFinal(): Promise<void> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM events WHERE status IN ('received', 'retrying')");
    const unpublished = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL');
    if (result.rows[0].count === '0' && unpublished.rows[0].count === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('full chaos drain timed out');
}
async function measure(): Promise<Counts> {
  const counts = await pool.query<{ status: string; count: string }>('SELECT status, count(*)::text AS count FROM events GROUP BY status');
  const processed = Number(counts.rows.find((row) => row.status === 'processed')?.count ?? 0);
  const dead = Number(counts.rows.find((row) => row.status === 'dead')?.count ?? 0);
  const duplicate = await pool.query('SELECT event_id FROM ledger_entries GROUP BY event_id HAVING count(*) > 1');
  return { unique: 500, processed, dead, lost: 500 - processed - dead, duplicateEffects: duplicate.rowCount ?? 0 };
}
async function invariants(): Promise<boolean> {
  const checks = await Promise.all([pool.query('SELECT event_id FROM ledger_entries GROUP BY event_id HAVING count(*) > 1'), pool.query("SELECT 1 FROM events WHERE status NOT IN ('processed', 'dead')"), pool.query("SELECT 1 FROM events e JOIN ledger_entries l ON l.event_id = e.id WHERE e.status = 'dead'"), pool.query('SELECT 1 FROM outbox WHERE published_at IS NULL'), pool.query('SELECT 1 FROM wallets WHERE balance_minor < 0'), redis.xpending('events:stream', 'workers').catch(() => ['0']), redis.xlen('events:stream'), redis.zcard('events:delayed')]);
  return checks[0].rowCount === 0 && checks[1].rowCount === 0 && checks[2].rowCount === 0 && checks[3].rowCount === 0 && checks[4].rowCount === 0 && Number((checks[5] as [string])[0] ?? 0) === 0 && Number(checks[6]) === 0 && Number(checks[7]) === 0;
}
async function runScenario(id: string, action: () => Promise<void>, intervalKill = false): Promise<void> {
  await reset();
  let timer: NodeJS.Timeout | undefined;
  let injectedAt = 0;
  try {
    if (intervalKill) timer = globalThis.setInterval(killWorker, 5000);
    await load(async () => { injectedAt = Date.now(); await action(); });
    if (timer) globalThis.clearInterval(timer);
    await waitForFinal();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const counts = await measure();
    const pass = counts.lost === 0 && counts.duplicateEffects === 0 && await invariants();
    const recovery = injectedAt ? Date.now() - injectedAt : null;
    results.push({ id, ...counts, status: pass ? 'PASS' : 'FAIL', recovery_ms: recovery, invariants: pass });
    console.log(`${id} ${pass ? 'PASS' : 'FAIL'} unique=${counts.unique} processed=${counts.processed} dead=${counts.dead} lost=${counts.lost} duplicate_effects=${counts.duplicateEffects} recovery_ms=${recovery ?? 0} INV=${pass ? 'PASS' : 'FAIL'}`);
  } catch (error) {
    results.push({ id, unique: 500, processed: 0, dead: 0, lost: 500, duplicateEffects: 0, status: 'FAIL', recovery_ms: null, invariants: false });
    console.error(`${id} FAIL ${error instanceof Error ? error.message : String(error)}`);
  } finally { if (timer) globalThis.clearInterval(timer); }
}
try {
  compose(['up', '-d', '--build', '--scale', 'worker=3']);
  execFileSync('pnpm', ['migrate'], { stdio: 'inherit' });
  await runScenario('CF-1', async () => { killWorker(); }, true);
  await runScenario('CF-2', async () => { compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']); });
  await runScenario('CF-3', async () => { compose(['restart', 'redis']); });
  await runScenario('CF-4', async () => { compose(['restart', 'postgres']); });
  await runScenario('CF-5', async () => { const worker = workerIds()[0]; if (!worker) throw new Error('No worker container'); execFileSync('docker', ['stop', worker], { stdio: 'pipe' }); });
  await runScenario('CF-6', async () => { killWorker(); compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']); }, true);
} finally {
  await mkdir('scripts/chaos', { recursive: true });
  await writeFile('scripts/chaos/results.json', JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + '\n');
  await redis.quit();
  await pool.end();
  try { compose(['down']); } catch { /* preserve measured results */ }
}
console.table(results);
if (results.length !== 6 || results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
