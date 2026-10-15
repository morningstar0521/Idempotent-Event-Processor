import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, UnavailableError, ValidationError } from '../../domain/errors.js';
import { DatabaseError } from '../../shared/db.js';

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  if (error instanceof ApiError) {
    return response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
  }
  if (error instanceof ZodError) {
    const validation = new ValidationError(error.issues.map(({ code, message, path }) => ({ code, message, path })));
    return response.status(validation.status).json({ error: { code: validation.code, message: validation.message, details: validation.details } });
  }
  if (error?.status === 413 || error?.status === 400) {
    return response.status(error.status).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is invalid', details: [] } });
  }
  const unavailable = new UnavailableError();
  if (error instanceof DatabaseError) {
    return response.status(unavailable.status).json({ error: { code: unavailable.code, message: unavailable.message, details: [] } });
  }
  return response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] } });
};
