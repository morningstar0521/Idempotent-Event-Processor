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

  it('U-FAN-5 leaves the fan-out stream off by default', () => {
    const loaded = loadConfig({});
    expect(loaded.FANOUT_STREAM).toBeUndefined();
    expect(loaded.FANOUT_MAXLEN).toBe(1000000);
    expect(loadConfig({ FANOUT_STREAM: '' }).FANOUT_STREAM).toBeUndefined();
  });

  it('U-FAN-6 accepts a fan-out stream and rejects unsafe fan-out settings', () => {
    expect(loadConfig({ FANOUT_STREAM: 'events:fanout', FANOUT_MAXLEN: '5000' })).toMatchObject({ FANOUT_STREAM: 'events:fanout', FANOUT_MAXLEN: 5000 });
    expect(() => loadConfig({ FANOUT_STREAM: 'events:stream' })).toThrow('FANOUT_STREAM');
    expect(() => loadConfig({ FANOUT_MAXLEN: '0' })).toThrow('Invalid configuration');
  });
});
