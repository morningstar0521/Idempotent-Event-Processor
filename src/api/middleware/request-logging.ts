import type { RequestHandler } from 'express';
import { logger } from '../../shared/logger.js';
import { apiRequestDuration } from '../../shared/metrics.js';

export const requestLogging: RequestHandler = (request, response, next) => {
  const started = process.hrtime.bigint();
  response.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    const route = request.route?.path ?? request.path;
    apiRequestDuration.labels(route, String(response.statusCode)).observe(duration);
    logger.info({ method: request.method, route, status: response.statusCode, duration_seconds: duration }, 'request');
  });
  next();
};
