import type { EventInput } from '../../src/domain/schemas.js';

type EventOverrides = { type?: EventInput['type']; merchant_id?: string; amount_minor?: number; payment_id?: string; payout_id?: string };

export function makeEvent(i: number, overrides: EventOverrides = {}): EventInput {
  const type = overrides.type ?? 'payment.captured';
  const merchant_id = overrides.merchant_id ?? `m_${i % 20}`;
  const amount_minor = overrides.amount_minor ?? 100 + (i % 900);
  const payload = type === 'payment.captured'
    ? { merchant_id, amount_minor, currency: 'INR' as const, payment_id: overrides.payment_id ?? `p_${i}` }
    : { merchant_id, amount_minor, currency: 'INR' as const, payout_id: overrides.payout_id ?? `payout_${i}` };
  return { type, payload } as EventInput;
}
