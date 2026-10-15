import { describe, expect, it } from 'vitest';
import { apiKeyMatches } from '../../src/api/middleware/auth.js';

describe('API key authentication', () => {
  it('U-9 handles equal and different lengths without throwing', () => {
    expect(apiKeyMatches('secret', 'secret')).toBe(true);
    expect(apiKeyMatches('wrong', 'secret')).toBe(false);
    expect(() => apiKeyMatches('short', 'secret')).not.toThrow();
    expect(apiKeyMatches(undefined, 'secret')).toBe(false);
  });
});
