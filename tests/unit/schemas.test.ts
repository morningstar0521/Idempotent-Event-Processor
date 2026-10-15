import { describe, expect, it } from 'vitest';
import { eventSchema, validateIdempotencyKey } from '../../src/domain/schemas.js';

const payment = {
  type: 'payment.captured' as const,
  payload: { merchant_id: 'm_1', amount_minor: 500, currency: 'INR' as const, payment_id: 'p_1' }
};

describe('event schemas', () => {
  it('U-3 accepts both event types and rejects invalid payloads', () => {
    expect(eventSchema.safeParse(payment).success).toBe(true);
    expect(eventSchema.safeParse({ type: 'payout.requested', payload: { merchant_id: 'm_1', amount_minor: 500, currency: 'INR', payout_id: 'p_1' } }).success).toBe(true);
    for (const amount_minor of [0, -1, 1.5, '500', 1_000_000_000_001]) {
      expect(eventSchema.safeParse({ ...payment, payload: { ...payment.payload, amount_minor } }).success).toBe(false);
    }
    expect(eventSchema.safeParse({ ...payment, payload: { ...payment.payload, currency: 'USD' } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...payment, payload: { ...payment.payload, merchant_id: 'bad id' } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...payment, payload: { ...payment.payload, payout_id: 'wrong-type-field' } }).success).toBe(false);
  });
});

describe('idempotency key validation', () => {
  it('U-4 accepts 1 and 255 characters and rejects missing, empty, and 256', () => {
    expect(validateIdempotencyKey('a')).toBe('a');
    expect(validateIdempotencyKey('a'.repeat(255))).toHaveLength(255);
    expect(() => validateIdempotencyKey(undefined)).toThrow();
    expect(() => validateIdempotencyKey('')).toThrow();
    expect(() => validateIdempotencyKey('a'.repeat(256))).toThrow();
  });
});
