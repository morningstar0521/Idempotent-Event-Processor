import { config } from '../../src/shared/config.js';
import { testQuery, testRedis } from '../integration/setup.js';

export type Expected = Map<string, number> | { balances?: Map<string, number>; keys?: number };

function expectedParts(expected?: Expected): { balances?: Map<string, number>; keys?: number } {
  if (expected instanceof Map) return { balances: expected };
  return expected ?? {};
}

export async function inv1(): Promise<void> {
  const result = await testQuery('SELECT event_id FROM ledger_entries GROUP BY event_id HAVING count(*) > 1');
  if (result.rowCount !== 0) throw new Error(`INV-1 duplicate effects: ${result.rowCount}`);
}

export async function inv2(): Promise<void> {
  const result = await testQuery(`SELECT w.merchant_id FROM wallets w LEFT JOIN ledger_entries l ON l.merchant_id = w.merchant_id GROUP BY w.merchant_id, w.balance_minor HAVING w.balance_minor <> COALESCE(SUM(l.amount_minor), 0)`);
  if (result.rowCount !== 0) throw new Error(`INV-2 wallet reconciliation mismatches: ${result.rowCount}`);
}

export async function inv3(expected?: Expected): Promise<void> {
  const parts = expectedParts(expected);
  if (parts.keys === undefined) return;
  const result = await testQuery<{ total: string; distinct_keys: string }>('SELECT count(*)::text AS total, count(DISTINCT idempotency_key)::text AS distinct_keys FROM events');
  if (Number(result.rows[0].total) !== parts.keys || Number(result.rows[0].distinct_keys) !== parts.keys) {
    throw new Error(`INV-3 event/key counts: ${JSON.stringify(result.rows[0])}, expected ${parts.keys}`);
  }
}

export async function inv4(): Promise<void> {
  const result = await testQuery<{ status: string; count: string }>("SELECT status, count(*)::text AS count FROM events WHERE status NOT IN ('processed', 'dead') GROUP BY status");
  if (result.rowCount !== 0) throw new Error(`INV-4 unfinished events: ${JSON.stringify(result.rows)}`);
}

export async function inv5(): Promise<void> {
  const counts = await testQuery<{ ledger: string; processed: string }>("SELECT (SELECT count(*) FROM ledger_entries)::text AS ledger, (SELECT count(*) FROM events WHERE status = 'processed')::text AS processed");
  const dead = await testQuery("SELECT e.id FROM events e JOIN ledger_entries l ON l.event_id = e.id WHERE e.status = 'dead'");
  if (counts.rows[0].ledger !== counts.rows[0].processed || dead.rowCount !== 0) throw new Error(`INV-5 effect/status mismatch: ${JSON.stringify({ counts: counts.rows[0], dead: dead.rowCount })}`);
}

export async function inv6(): Promise<void> {
  const result = await testQuery<{ event_id: string; count: string; unpublished: string }>(`SELECT e.id AS event_id, count(o.id)::text AS count, count(o.id) FILTER (WHERE o.published_at IS NULL)::text AS unpublished FROM events e LEFT JOIN outbox o ON o.event_id = e.id GROUP BY e.id HAVING count(o.id) <> 1 OR count(o.id) FILTER (WHERE o.published_at IS NULL) <> 0`);
  if (result.rowCount !== 0) throw new Error(`INV-6 outbox mismatches: ${result.rowCount}`);
}

export async function inv7(): Promise<void> {
  const result = await testQuery("SELECT id FROM events WHERE (status = 'processed' AND (processed_at IS NULL OR attempts < 1)) OR (status = 'dead' AND (last_error IS NULL OR last_error_kind IS NULL))");
  if (result.rowCount !== 0) throw new Error(`INV-7 metadata violations: ${result.rowCount}`);
}

export async function inv8(expected?: Expected): Promise<void> {
  const balances = expectedParts(expected).balances;
  if (!balances) return;
  const result = await testQuery<{ merchant_id: string; balance_minor: string }>('SELECT merchant_id, balance_minor::text FROM wallets');
  for (const [merchant, balance] of balances) {
    const actual = result.rows.find((row) => row.merchant_id === merchant)?.balance_minor;
    if (actual !== String(balance)) throw new Error(`INV-8 balance mismatch for ${merchant}: got ${actual ?? 'missing'}, expected ${balance}`);
  }
}

export async function inv9(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, config.LOCK_TTL_MS));
  const deadline = Date.now() + 60000;
  let state = { pending: 0, length: 0, delayed: 0, locks: 0 };
  while (Date.now() < deadline) {
    let pending = 0;
    try {
      const result = await testRedis.xpending('events:stream', 'workers') as unknown as [string, number, string, string];
      pending = Number(result[0] ?? 0);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('NOGROUP'))) throw error;
    }
    const [length, delayed, locks] = await Promise.all([
      testRedis.xlen('events:stream'),
      testRedis.zcard('events:delayed'),
      testRedis.scan(0, 'MATCH', 'lock:event:*', 'COUNT', 1000),
    ]);
    state = { pending, length, delayed, locks: locks[1].length };
    if (pending === 0 && length === 0 && delayed === 0 && locks[1].length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let details: unknown = [];
  try { details = await testRedis.xpending('events:stream', 'workers', '-', '+', 10); } catch { /* include the summary when details are unavailable */ }
  throw new Error(`INV-9 Redis not clean: ${JSON.stringify({ ...state, details })}`);
}

export async function inv10(): Promise<void> {
  const result = await testQuery('SELECT 1 FROM wallets WHERE balance_minor < 0');
  if (result.rowCount !== 0) throw new Error(`INV-10 negative wallets: ${result.rowCount}`);
}

const checks: Array<[string, (expected?: Expected) => Promise<void>]> = [
  ['INV-1', inv1], ['INV-2', inv2], ['INV-3', inv3], ['INV-4', inv4], ['INV-5', inv5],
  ['INV-6', inv6], ['INV-7', inv7], ['INV-8', inv8], ['INV-9', inv9], ['INV-10', inv10],
];

export async function assertInvariants(expected?: Expected): Promise<void> {
  const results: Array<{ id: string; status: 'PASS' | 'FAIL'; error?: string }> = [];
  for (const [id, check] of checks) {
    try {
      await check(expected);
      results.push({ id, status: 'PASS' });
    } catch (error) {
      results.push({ id, status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failures = results.filter((result) => result.status === 'FAIL');
  if (failures.length > 0) {
    console.error('Invariant results', results);
    throw new Error(failures.map((failure) => `${failure.id}: ${failure.error}`).join('\n'));
  }
}
