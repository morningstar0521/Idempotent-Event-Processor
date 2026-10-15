export type ErrorKind = 'transient' | 'permanent';

export class PermanentError extends Error {
  readonly kind = 'permanent' as const;
}

export class TransientError extends Error {
  readonly kind = 'transient' as const;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ValidationError extends ApiError {
  constructor(details: unknown[] = []) {
    super(400, 'VALIDATION_ERROR', 'Request body is invalid', details);
  }
}

export class MissingIdempotencyKeyError extends ApiError {
  constructor() {
    super(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'Invalid API key');
  }
}

export class NotFoundError extends ApiError {
  constructor() {
    super(404, 'NOT_FOUND', 'Event not found');
  }
}

export class IdempotencyKeyReusedError extends ApiError {
  constructor() {
    super(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different body');
  }
}

export class UnavailableError extends ApiError {
  constructor() {
    super(503, 'UNAVAILABLE', 'Database is unavailable');
  }
}
