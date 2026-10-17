import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { LoadPlan } from './load/plan.js';

const exec = promisify(execFile);
const [summaryPath, snapshotPath, planPath, invariantPath] = process.argv.slice(2);
if (!summaryPath || !snapshotPath || !planPath || !invariantPath) throw new Error('Usage: tsx scripts/report.ts <summary> <metrics> <plan> <invariants>');
type K6Summary = { metrics: Record<string, Record<string, number> & { values?: Record<string, number> }> };
type Snapshots = { before: Record<string, string[]>; after: Record<string, string[]> };
type Invariants = { status: string; invariants: Array<{ id: string; status: string }> };
const [summary, snapshots, plan, invariants] = await Promise.all([
  readJson<K6Summary>(summaryPath), readJson<Snapshots>(snapshotPath), readJson<LoadPlan>(planPath), readJson<Invariants>(invariantPath),
]);
if (invariants.status !== 'PASS') throw new Error('Refusing to write RESULTS.md because invariants did not pass');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/events' });
process.once('uncaughtException', async (error) => {
  await pool.end();
  console.error(error);
  process.exitCode = 1;
});

async function readJson<T>(path: string): Promise<T> {
  if (!path) throw new Error('Missing report source path');
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Missing measured metric: ${name}`);
  return value;
}

function metricValue(snapshot: Record<string, string[]>, metric: string, labels = ''): number {
  let total = 0;
  let found = false;
  let declared = false;
  for (const text of Object.values(snapshot)) for (const line of text) {
    if (line === `# TYPE ${metric} counter` || line === `# TYPE ${metric} gauge`) declared = true;
    if (line.startsWith('#') || !line.startsWith(metric)) continue;
    const match = line.match(new RegExp(`^${metric}(?:\\{([^}]*)\\})?\\s+([0-9.eE+-]+)$`));
    if (!match) continue;
    if (labels && match[1] !== labels) continue;
    total += Number(match[2]);
    found = true;
  }
  if (!found && !declared) throw new Error(`Missing metric ${metric}${labels ? `{${labels}}` : ''}`);
  return total;
}

function counter(name: string): number {
  const metric = summary.metrics?.[name];
  return number(metric?.values?.count ?? metric?.count, name);
}

function percentile(name: string, key: string): number {
  const metric = summary.metrics?.[name];
  return number(metric?.values?.[key] ?? metric?.[key], `${name}.${key}`);
}

function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2); }

const before = snapshots.before as Record<string, string[]>;
const after = snapshots.after as Record<string, string[]>;
const totalRequests = counter('http_reqs');
const created = counter('responses_202');
const duplicates = counter('responses_200');
const errors = counter('responses_errors');
const reused = counter('responses_422');
if (errors !== 0 || reused !== 0) throw new Error(`Measured request errors: errors=${errors}, 422=${reused}`);
const db = await pool.query<{ processed: string; dead: string; unfinished: string; ledger: string }>(`SELECT
  (SELECT count(*) FROM events WHERE idempotency_key = ANY($1::text[]) AND status = 'processed')::text AS processed,
  (SELECT count(*) FROM events WHERE idempotency_key = ANY($1::text[]) AND status = 'dead')::text AS dead,
  (SELECT count(*) FROM events WHERE idempotency_key = ANY($1::text[]) AND status NOT IN ('processed', 'dead'))::text AS unfinished,
  (SELECT count(*) FROM ledger_entries l JOIN events e ON e.id = l.event_id WHERE e.idempotency_key = ANY($1::text[]))::text AS ledger`, [plan.requests.map((request) => request.key).concat(plan.scenario === 'same_key_storm' ? ['same-key-storm'] : [])]);
const e2e = await pool.query<{ p50: number; p95: number; p99: number }>(`SELECT
  percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000) AS p95,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - created_at) * 1000) AS p99
  FROM events WHERE idempotency_key = ANY($1::text[]) AND processed_at IS NOT NULL`, [plan.requests.map((request) => request.key).concat(plan.scenario === 'same_key_storm' ? ['same-key-storm'] : [])]);
if (db.rows[0].unfinished !== '0') throw new Error(`Unfinished events: ${db.rows[0].unfinished}`);
if (db.rows[0].ledger !== db.rows[0].processed) throw new Error(`Ledger mismatch: ${db.rows[0].ledger} vs ${db.rows[0].processed}`);
if (!e2e.rows[0].p95) throw new Error('Missing end-to-end latency query result');
const rate = Number(summary.metrics?.http_reqs?.values?.rate ?? summary.metrics?.http_reqs?.rate);
if (!Number.isFinite(rate)) throw new Error('Missing measured ingest rate');
const processedRate = await pool.query<{ rate: number }>(`SELECT count(*) / NULLIF(extract(epoch FROM max(processed_at) - min(created_at)), 0) AS rate FROM events WHERE idempotency_key = ANY($1::text[]) AND status = 'processed'`, [plan.requests.map((request) => request.key).concat(plan.scenario === 'same_key_storm' ? ['same-key-storm'] : [])]);
if (!Number.isFinite(processedRate.rows[0].rate)) throw new Error('Missing measured processed rate');
const gitSha = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
const dockerVersion = (await exec('docker', ['version', '--format', '{{.Server.Version}}'])).stdout.trim();
const workerCount = (await exec('docker', ['compose', 'ps', '-q', 'worker'])).stdout.trim().split('\n').filter(Boolean).length;
const config = await readFile('.env.example', 'utf8');
const chaos = await readFile('scripts/chaos/results.json', 'utf8');
const cpu = os.cpus()[0]?.model;
if (!cpu || !dockerVersion || workerCount < 1) throw new Error('Missing machine or worker measurement');

const duplicateLayers = ['api', 'lock', 'db_status', 'ledger_constraint'].map((layer) => {
  const beforeValue = metricValue(before, 'duplicates_blocked_total', `layer="${layer}"`);
  const afterValue = metricValue(after, 'duplicates_blocked_total', `layer="${layer}"`);
  return `| ${layer} | ${format(afterValue - beforeValue)} |`;
}).join('\n');
const runNote = await readOptional('/tmp/load-stability-note.md');
const output = `# Load test results

Status: PASS

## Header

- Run date: ${new Date().toISOString()}
- Git SHA: ${gitSha}
- Node: ${process.version}
- Machine: ${cpu}; ${os.cpus().length} cores; ${format(os.totalmem() / 1024 / 1024 / 1024)} GiB RAM; ${os.platform()} ${os.release()}
- Docker server: ${dockerVersion}
- Worker count: ${workerCount}

### Configuration

\`\`\`dotenv
${config.trim()}
\`\`\`

## Requests

| Metric | Measured |
|---|---:|
| Total requests sent | ${format(totalRequests)} |
| Unique idempotency keys | ${format(plan.scenario === 'same_key_storm' ? 1 : plan.unique_events)} |
| 202 responses | ${format(created)} |
| 200 responses | ${format(duplicates)} |
| Errors | ${format(errors)} |
| 422 responses | ${format(reused)} |

## Throughput

| Metric | Measured |
|---|---:|
| Ingest rate (requests/sec) | ${format(rate)} |
| Processed rate (events/sec) | ${format(processedRate.rows[0].rate)} |

## Latency (${plan.scenario})

| Source | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| API request duration | ${format(percentile('http_req_duration', 'med'))} | ${format(percentile('http_req_duration', 'p(95)'))} | ${format(percentile('http_req_duration', 'p(99)'))} |
| End-to-end | ${format(e2e.rows[0].p50)} | ${format(e2e.rows[0].p95)} | ${format(e2e.rows[0].p99)} |

## Duplicates blocked by layer

| Layer | Count |
|---|---:|
${duplicateLayers}

## Retries and dead

- events_retried_total: ${format(metricValue(after, 'events_retried_total') - metricValue(before, 'events_retried_total'))}
- events_dead_total{reason="permanent"}: ${format(metricValue(after, 'events_dead_total', 'reason="permanent"') - metricValue(before, 'events_dead_total', 'reason="permanent"'))}
- events_dead_total{reason="max_attempts"}: ${format(metricValue(after, 'events_dead_total', 'reason="max_attempts"') - metricValue(before, 'events_dead_total', 'reason="max_attempts"'))}
- events_dead_total{reason="max_deliveries"}: ${format(metricValue(after, 'events_dead_total', 'reason="max_deliveries"') - metricValue(before, 'events_dead_total', 'reason="max_deliveries"'))}

## Invariants

| Invariant | Status |
|---|---|
${invariants.invariants.map((item: { id: string; status: string }) => `| ${item.id} | ${item.status} |`).join('\n')}

## Chaos full

\`\`\`json
${chaos.trim()}
\`\`\`

## Notes

- These numbers were captured on a single machine and are not a capacity claim.
- See docs/DECISIONS.md section H for honest limits.
- Re-run to reproduce: pnpm load
${runNote ? `- ${runNote.trim()}\n` : ''}`;
await writeFile('docs/RESULTS.md', output);
await pool.end();

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}
