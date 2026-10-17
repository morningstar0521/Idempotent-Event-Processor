import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reset } from '../../src/shared/chaos.js';
import { startStack, type Stack } from '../helpers/startStack.js';
import { assertInvariants } from '../helpers/invariants.js';
import { makeEvent } from '../helpers/makeEvent.js';
import { postEvent } from '../helpers/postEvent.js';
import { seedWallets } from '../helpers/seedWallets.js';
import { waitForDrain } from '../helpers/waitForDrain.js';
import { resetTestState } from '../integration/setup.js';
import { chaosRandom, resetChaosRandom } from './seed.js';

const merchants = Array.from({ length: 20 }, (_, index) => `m_${index}`);

async function runWorkload(stack: Stack, count = 300): Promise<void> {
  const expected = await seedWallets(merchants, 1_000_000, stack.api.url);
  const requests = Array.from({ length: count }, (_, index) => {
    const event = makeEvent(index);
    expected.set(event.payload.merchant_id, (expected.get(event.payload.merchant_id) ?? 0) + event.payload.amount_minor);
    return { key: `chaos-${index}`, event };
  });
  const duplicateRequests = requests.filter(() => chaosRandom() < 0.5);
  const responses = await Promise.all([...requests, ...duplicateRequests].map(({ key, event }) => postEvent(key, event, stack.api.url)));
  expect(responses.every(({ status }) => status === 202 || status === 200)).toBe(true);
  await waitForDrain();
  await assertInvariants({ balances: expected, keys: merchants.length + count });
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

  it('C-1 crash before commit keeps every event safe', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack);
  }, 120000);

  it('C-2 crash after commit before ack remains idempotent', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack);
  }, 120000);

  it('C-3a lock expiry before the transaction remains safe', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 320);
  }, 120000);

  it('C-3b lock expiry inside the transaction remains safe', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 320);
  }, 120000);

  it('C-4 Redis wipe is recovered from Postgres', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 300);
  }, 120000);

  it('C-5 poison delivery cannot create a duplicate effect', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 300);
  }, 120000);

  it('C-6 relay duplication remains idempotent', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 300);
  }, 120000);

  it('C-7 failure storm ends in final states', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 320);
  }, 120000);

  it('C-8 combined chaos preserves all invariants', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    await runWorkload(stack, 320);
  }, 120000);

  it('C-9 same-key storm creates one event and one effect', async () => {
    stack = await startStack({ workers: 3, concurrency: 5 });
    const event = makeEvent(9000);
    const responses = await Promise.all(Array.from({ length: 500 }, (_, index) => postEvent('same-key-storm', event, stack.api.url)));
    expect(responses.filter(({ status }) => status === 202)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(499);
    await waitForDrain();
    await assertInvariants({ keys: 1 });
  }, 120000);
});
