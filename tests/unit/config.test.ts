import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

describe('configuration', () => {
  it('U-7 rejects invalid numbers and chaos in production', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow('Invalid configuration');
    expect(() => loadConfig({ NODE_ENV: 'production', CHAOS_ENABLED: 'true' })).toThrow('CHAOS_ENABLED');
  });

  it('requires sweeper staleness to exceed the retry backoff cap', () => {
    expect(() => loadConfig({ BACKOFF_CAP_MS: '30000', SWEEP_STALE_MS: '30000' })).toThrow('SWEEP_STALE_MS');
  });
});

