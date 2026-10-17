import { writeFile } from 'node:fs/promises';
import { makeEvent } from '../../tests/helpers/makeEvent.js';

export type LoadRequest = { key: string; body: ReturnType<typeof makeEvent>; isDuplicate: boolean };
export type LoadPlan = {
  run_id: string;
  scenario: string;
  unique_events: number;
  requests: LoadRequest[];
  expected_balances: Record<string, number>;
  stormBody: ReturnType<typeof makeEvent>;
};

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

export function createPlan(runId: string, uniqueEvents: number, duplicateRatio: number, scenario: string): LoadPlan {
  const requests: LoadRequest[] = [];
  const expectedBalances = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`m_${index}`, 1_000_000]));
  const stormBody = makeEvent(0);
  if (scenario === 'same_key_storm') expectedBalances[stormBody.payload.merchant_id] += stormBody.payload.amount_minor;
  const duplicates = Math.floor(uniqueEvents * duplicateRatio);
  for (let index = 0; index < uniqueEvents; index += 1) {
    const body = makeEvent(index);
    requests.push({ key: `load-${runId}-${index}`, body, isDuplicate: false });
    expectedBalances[body.payload.merchant_id] += body.payload.amount_minor;
    if (index < duplicates) requests.push({ key: `load-${runId}-${index}`, body, isDuplicate: true });
  }
  const plan: LoadPlan = {
    run_id: runId,
    scenario,
    unique_events: uniqueEvents,
    requests: shuffle(requests),
    expected_balances: expectedBalances,
    stormBody,
  };
  if (scenario === 'same_key_storm') plan.requests = [];
  if (plan.requests.filter((request) => request.isDuplicate).some((request) => request.body !== plan.requests.find((candidate) => candidate.key === request.key && !candidate.isDuplicate)?.body)) {
    throw new Error('Generated duplicate request does not reuse the original body');
  }
  return plan;
}

export async function writePlan(path: string, plan: LoadPlan): Promise<void> {
  await writeFile(path, JSON.stringify(plan, null, 2));
}
