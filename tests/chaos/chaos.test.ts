import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { configure, reset } from '../../src/shared/chaos.js';
import { chaosFires, duplicateStreamMessages, duplicatesBlocked, eventsDead, eventsRetried, lockRecovered, lockTimeoutWaits, sweeperRequeued } from '../../src/shared/metrics.js';
import { startStack, type Stack } from '../helpers/startStack.js';
import { assertInvariants } from '../helpers/invariants.js';
import { makeEvent } from '../helpers/makeEvent.js';
import { postEvent } from '../helpers/postEvent.js';
import { seedWallets } from '../helpers/seedWallets.js';
import { waitForDrain } from '../helpers/waitForDrain.js';
import { resetTestState, testQuery, testRedis } from '../integration/setup.js';
import { chaosRandom, resetChaosRandom } from './seed.js';

const merchants = Array.from({ length: 20 }, (_, index) => `m_${index}`);
type LoadOptions = { onHalf?: () => Promise<void>; extraKeys?: number; skipModel?: boolean };

async function counterValue(counter: { get(): Promise<unknown> }, labels: Record<string, string> = {}): Promise<number> {
  const metric = await counter.get() as { values: Array<{ labels: Record<string, string | number>; value: number }> };
  if (Object.keys(labels).length === 0) return metric.values.reduce((total, item) => total + Number(item.value), 0);
  const value = metric.values.find((item) => Object.entries(labels).every(([key, expected]) => item.labels[key] === expected));
  return Number(value?.value ?? 0);
}

async function loadEvents(stack: Stack, count: number, expected: Map<string, number>, options: LoadOptions = {}): Promise<void> {
  const requests = Array.from({ length: count }, (_, index) => {
    const event = makeEvent(index);
    expected.set(event.payload.merchant_id, (expected.get(event.payload.merchant_id) ?? 0) + event.payload.amount_minor);
    return { key: `chaos-${index}`, event };
  });
  const duplicates = requests.filter(() => chaosRandom() < 0.5);
  const all = [...requests, ...duplicates];
  const midpoint = Math.floor(all.length / 2);
  const send = (items: typeof all) => Promise.all(items.map(({ key, event }) => postEvent(key, event, stack.api.url)));
  const first = await send(all.slice(0, midpoint));
  if (options.onHalf) await options.onHalf();
  const second = await send(all.slice(midpoint));
  expect([...first, ...second].every(({ status }) => status === 202 || status === 200)).toBe(true);
}

async function insertQueuedEvent(key: string, event: ReturnType<typeof makeEvent>): Promise<string> {
  const inserted = await testQuery<{ id: string }>(
    `INSERT INTO events (idempotency_key, type, payload, payload_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [key, event.type, event.payload, randomUUID()],
  );
  const id = inserted.rows[0].id;
  return id;
}

async function publishQueuedEvent(id: string): Promise<void> {
  await testQuery('INSERT INTO outbox (event_id) VALUES ($1)', [id]);
}

async function counterBaseline(): Promise<Record<string, number>> {
  return {
    chaos: await counterValue(chaosFires),
    api: await counterValue(duplicatesBlocked, { layer: 'api' }),
    db: await counterValue(duplicatesBlocked, { layer: 'db_status' }),
    lock: await counterValue(duplicatesBlocked, { layer: 'lock' }),
    stream: await counterValue(duplicateStreamMessages),
    maxAttempts: await counterValue(eventsDead, { reason: 'max_attempts' }),
    maxDeliveries: await counterValue(eventsDead, { reason: 'max_deliveries' }),
    retried: await counterValue(eventsRetried),
    crashBefore: await counterValue(chaosFires, { cause: 'crash_before_commit' }),
    crashAfter: await counterValue(chaosFires, { cause: 'crash_after_commit' }),
    pauseBefore: await counterValue(chaosFires, { cause: 'pause_before_tx' }),
    pauseInside: await counterValue(chaosFires, { cause: 'pause_inside_tx' }),
    relayCrash: await counterValue(chaosFires, { cause: 'crash_relay_after_xadd' }),
    failBefore: await counterValue(chaosFires, { cause: 'fail_before_effect' }),
    recovered: await counterValue(lockRecovered),
    lockWait: await counterValue(lockTimeoutWaits),
    swept: await counterValue(sweeperRequeued),
  };
}

async function report(scenario: string, before: Record<string, number>, recoveryMs = 0): Promise<void> {
  const statuses = await testQuery<{ status: string; count: string }>('SELECT status, count(*)::text AS count FROM events GROUP BY status');
  const processed = Number(statuses.rows.find((row) => row.status === 'processed')?.count ?? 0);
  const dead = Number(statuses.rows.find((row) => row.status === 'dead')?.count ?? 0);
  const causes = Math.round((await counterValue(chaosFires)) - before.chaos);
  const dupApi = Math.round((await counterValue(duplicatesBlocked, { layer: 'api' })) - before.api);
  const dupDb = Math.round((await counterValue(duplicatesBlocked, { layer: 'db_status' })) - before.db);
  const dupLock = Math.round((await counterValue(duplicatesBlocked, { layer: 'lock' })) - before.lock);
  console.log(`[${scenario}] chaos_fires=${causes} processed=${processed} dead=${dead} dup_blocked={api:${dupApi},db_status:${dupDb},lock:${dupLock}} recovery_ms=${recoveryMs} INV=PASS`);
}

async function runSeededScenario(stack: Stack, scenario: string, count: number, options: LoadOptions = {}): Promise<void> {
  const expected = await seedWallets(merchants, 1_000_000, stack.api.url);
  await loadEvents(stack, count, expected, options);
  await waitForDrain();
  await assertInvariants({ balances: options.skipModel ? undefined : expected, keys: merchants.length + count + (options.extraKeys ?? 0) });
}

function enable(): void {
  process.env.CHAOS_ENABLED = 'true';
}

describe.sequential('Phase 6 chaos lite', () => {
  let stack: Stack;

  beforeEach(async () => {
    process.env.CHAOS_ENABLED = 'false';
    reset();
    resetChaosRandom();
    await resetTestState();
  });

  afterEach(async () => {
    reset();
    process.env.CHAOS_ENABLED = 'false';
    if (stack) await stack.stop();
    stack = undefined as never;
  });

  it('C-1 crash before commit is recovered by redelivery', async () => {
    enable(); configure({ crashBeforeCommit: { prob: 0.3 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runSeededScenario(stack, 'C-1', 300);
    expect(await counterValue(chaosFires, { cause: 'crash_before_commit' })).toBeGreaterThan(before.crashBefore);
    const unfinished = await testQuery("SELECT count(*)::text AS count FROM events WHERE status <> 'processed'");
    expect(Number(unfinished.rows[0].count)).toBe(0);
    await report('C-1', before);
  }, 120000);

  it('C-2 crash after commit is skipped by database status', async () => {
    enable(); configure({ crashAfterCommit: { prob: 0.3 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runSeededScenario(stack, 'C-2', 300);
    expect(await counterValue(chaosFires, { cause: 'crash_after_commit' })).toBeGreaterThan(before.crashAfter);
    expect((await counterValue(duplicatesBlocked, { layer: 'db_status' })) - before.db).toBeGreaterThan(0);
    await report('C-2', before);
  }, 120000);

  it('C-3a pause before transaction recovers after lock expiry', async () => {
    enable(); configure({ pauseBeforeTx: { durationMs: 2000 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5, pauseWorkerId: 0, disableHeartbeatWorkerId: 0 });
    await runSeededScenario(stack, 'C-3a', 300);
    expect(await counterValue(chaosFires, { cause: 'pause_before_tx' })).toBeGreaterThan(before.pauseBefore);
    expect(await counterValue(lockRecovered)).toBeGreaterThan(before.recovered);
    await report('C-3a', before);
  }, 120000);

  it('C-3b pause inside transaction records row-lock wait', async () => {
    enable(); configure({ pauseInsideTx: { durationMs: 2000 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5, pauseWorkerId: 0, disableHeartbeatWorkerId: 0 });
    const expected = await seedWallets(merchants, 1_000_000, stack.api.url);
    const lockEvent = makeEvent(9100);
    const lockEventId = await insertQueuedEvent('c3b-lock', lockEvent);
    expected.set(lockEvent.payload.merchant_id, (expected.get(lockEvent.payload.merchant_id) ?? 0) + lockEvent.payload.amount_minor);
    await publishQueuedEvent(lockEventId);
    await testRedis.xadd('events:stream', '*', 'event_id', lockEventId);
    await testRedis.xadd('events:stream', '*', 'event_id', lockEventId);
    await loadEvents(stack, 300, expected);
    await waitForDrain();
    await assertInvariants({ balances: expected, keys: merchants.length + 301 });
    expect(await counterValue(chaosFires, { cause: 'pause_inside_tx' })).toBeGreaterThan(before.pauseInside);
    expect(await counterValue(lockTimeoutWaits)).toBeGreaterThan(before.lockWait);
    await report('C-3b', before);
  }, 120000);

  it('C-4 Redis wipe is recovered by the sweeper', async () => {
    enable();
    const before = await counterBaseline();
    const started = Date.now();
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runSeededScenario(stack, 'C-4', 300, { onHalf: async () => { await testRedis.flushdb(); } });
    const recoveryMs = Date.now() - started;
    expect(await counterValue(sweeperRequeued)).toBeGreaterThan(before.swept);
    expect(recoveryMs).toBeLessThan(30000);
    await report('C-4', before, recoveryMs);
  }, 120000);

  it('C-5 poison message reaches the delivery cap', async () => {
    enable();
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    const expected = await seedWallets(merchants, 1_000_000, stack.api.url);
    const poisonEventId = await insertQueuedEvent('poison-event', makeEvent(7000));
    configure({ poisonEventId: poisonEventId });
    await testQuery('INSERT INTO outbox (event_id, published_at) VALUES ($1, now())', [poisonEventId]);
    await testRedis.xadd('events:stream', '*', 'event_id', poisonEventId);
    await loadEvents(stack, 300, expected);
    await waitForDrain(60000);
    await assertInvariants({ balances: expected, keys: merchants.length + 301 });
    const dead = await testQuery<{ count: string }>("SELECT count(*)::text AS count FROM events WHERE status = 'dead' AND last_error = 'max deliveries exceeded'");
    expect(Number(dead.rows[0].count)).toBe(1);
    expect((await counterValue(eventsDead, { reason: 'max_deliveries' })) - before.maxDeliveries).toBe(1);
    await report('C-5', before);
  }, 120000);

  it('C-6 relay crash after XADD creates a duplicate stream message', async () => {
    enable(); configure({ crashRelayAfterXadd: { prob: 1, firesOnce: true } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runSeededScenario(stack, 'C-6', 300);
    expect(await counterValue(chaosFires, { cause: 'crash_relay_after_xadd' })).toBeGreaterThan(before.relayCrash);
    expect((await counterValue(duplicateStreamMessages)) - before.stream).toBeGreaterThan(0);
    await report('C-6', before);
  }, 120000);

  it('C-7 transient failure storm produces retries and dead events', async () => {
    enable();
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    const expected = await seedWallets(merchants, 1_000_000, stack.api.url);
    const forcedEventId = await insertQueuedEvent('forced-dead', makeEvent(8000));
    configure({ failBeforeEffect: { prob: 0.3 }, failAlwaysEventId: forcedEventId });
    await publishQueuedEvent(forcedEventId);
    await loadEvents(stack, 300, expected);
    await waitForDrain();
    await assertInvariants({ keys: merchants.length + 301 });
    expect((await counterValue(eventsRetried)) - before.retried).toBeGreaterThan(0);
    expect((await counterValue(eventsDead, { reason: 'max_attempts' })) - before.maxAttempts).toBeGreaterThan(0);
    await report('C-7', before);
  }, 120000);

  it('C-8 combined crash, failure, and Redis wipe preserves invariants', async () => {
    enable(); configure({ crashBeforeCommit: { prob: 0.1 }, crashAfterCommit: { prob: 0.1 }, failBeforeEffect: { prob: 0.2 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runSeededScenario(stack, 'C-8', 300, { onHalf: async () => { await testRedis.flushdb(); } });
    expect(await counterValue(chaosFires, { cause: 'crash_before_commit' })).toBeGreaterThan(before.crashBefore);
    expect(await counterValue(chaosFires, { cause: 'crash_after_commit' })).toBeGreaterThan(before.crashAfter);
    expect(await counterValue(chaosFires, { cause: 'fail_before_effect' })).toBeGreaterThan(before.failBefore);
    expect(await counterValue(sweeperRequeued)).toBeGreaterThan(before.swept);
    await report('C-8', before);
  }, 120000);

  it('C-9 same-key storm creates one event and one effect', async () => {
    enable(); configure({ crashBeforeCommit: { prob: 1 } });
    const before = await counterBaseline();
    stack = await startStack({ workers: 3, concurrency: 5 });
    const event = makeEvent(9000);
    const responses = await Promise.all(Array.from({ length: 500 }, () => postEvent('same-key-storm', event, stack.api.url)));
    expect(responses.filter(({ status }) => status === 202)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(499);
    await waitForDrain();
    await assertInvariants({ keys: 1 });
    expect((await testQuery('SELECT count(*) FROM events')).rows[0].count).toBe('1');
    expect((await testQuery('SELECT count(*) FROM ledger_entries')).rows[0].count).toBe('1');
    expect((await counterValue(duplicatesBlocked, { layer: 'api' })) - before.api).toBe(499);
    expect(await counterValue(chaosFires, { cause: 'crash_before_commit' })).toBeGreaterThan(before.crashBefore);
    await report('C-9', before);
  }, 120000);
});
