import { describe, expect, it } from 'vitest';
import * as chaos from '../../src/shared/chaos.js';

describe('chaos', () => {
  it('U-8 remains inert when disabled', async () => {
    const previous = process.env.CHAOS_ENABLED;
    process.env.CHAOS_ENABLED = 'false';
    chaos.configure({ crash: true, failCounter: 2 });
    expect(() => chaos.failBeforeEffect()).not.toThrow();
    expect(() => chaos.crashBeforeCommit()).not.toThrow();
    expect(() => chaos.crashAfterCommit()).not.toThrow();
    await expect(chaos.pause('inside_tx')).resolves.toBeUndefined();
    if (previous === undefined) delete process.env.CHAOS_ENABLED;
    else process.env.CHAOS_ENABLED = previous;
  });
});

