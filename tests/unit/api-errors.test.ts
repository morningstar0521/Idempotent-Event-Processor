import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/api/middleware/errors.js';
import { ValidationError } from '../../src/domain/errors.js';

describe('API error output', () => {
  it('U-10 contains no payload contents', () => {
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })) };
    errorHandler(new ValidationError([{ path: ['payload'], code: 'custom', message: 'invalid' }]), {} as never, response as never, vi.fn());
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('merchant_id');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('amount_minor');
  });
});
