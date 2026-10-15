import { describe, expect, it } from 'vitest';
import { payloadHash, stableStringify } from '../../src/shared/hash.js';

describe('hashing', () => {
  it('U-1 sorts object keys recursively while preserving arrays', () => {
    expect(stableStringify({ b: { y: 2, x: 1 }, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":{"x":1,"y":2}}');
  });

  it('U-2 hashes equal payloads equally and changed fields differently', () => {
    expect(payloadHash('payment.captured', { amount_minor: 1 })).toBe(payloadHash('payment.captured', { amount_minor: 1 }));
    expect(payloadHash('payment.captured', { amount_minor: 1 })).not.toBe(payloadHash('payment.captured', { amount_minor: 2 }));
    expect(payloadHash('payment.captured', { amount_minor: 1 })).not.toBe(payloadHash('payout.requested', { amount_minor: 1 }));
  });
});

