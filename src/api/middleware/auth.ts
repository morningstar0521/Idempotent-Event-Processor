import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { RequestHandler } from 'express';
import { config } from '../../shared/config.js';
import { UnauthorizedError } from '../../domain/errors.js';

export function apiKeyMatches(received: string | undefined, expected = config.API_KEY): boolean {
  if (received === undefined) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export const requireApiKey: RequestHandler = (request, _response, next) => {
  if (!apiKeyMatches(request.header('X-API-Key'))) return next(new UnauthorizedError());
  next();
};
