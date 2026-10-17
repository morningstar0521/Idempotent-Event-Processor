import { describe, expect, it } from 'vitest';
import { PermanentError } from '../../src/domain/errors.js';
import { classify, computeBackoff } from '../../src/worker/retry.js';
import { config } from '../../src/shared/config.js';

describe('retry policy', () => {
  it('U-5 uses full jitter, respects the cap, and rejects invalid RNG output', () => {
    expect(computeBackoff(1, () => 0)).toBe(0);
    expect(computeBackoff(1, () => 1)).toBe(config.BACKOFF_BASE_MS);
    expect(computeBackoff(1000, () => 1)).toBe(config.BACKOFF_CAP_MS);
    expect(computeBackoff(1, () => -1)).toBe(0);
    expect(computeBackoff(1, () => Number.NaN)).toBe(0);
    expect(computeBackoff(1, () => Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('U-6 classifies permanent and known transient errors', () => {
    expect(classify(new PermanentError('INSUFFICIENT_FUNDS'))).toBe('permanent');
    expect(classify(new Error('unknown'))).toBe('transient');
    for (const code of ['40001', '40P01', '55P03', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(classify(Object.assign(new Error(code), { code }))).toBe('transient');
    }
  });
});
