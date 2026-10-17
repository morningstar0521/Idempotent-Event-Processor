import type { Router } from 'express';
import type { Redis } from 'ioredis';
import type { QueryResult } from 'pg';
import { ValidationError, UnavailableError, ApiError } from '../../domain/errors.js';
import { query, withTx } from '../../shared/db.js';
import { redis } from '../../shared/redis.js';

const STREAM = 'events:stream';

export interface AdminRouteOptions {
  queryFn?: typeof query;
  withTxFn?: typeof withTx;
  redisClient?: Redis;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new ValidationError();
  return Math.min(limit, 200);
}

function parseBefore(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ValidationError();
  return date;
}

export function registerAdminRoutes(router: Router, options: AdminRouteOptions = {}): void {
  const queryFn = options.queryFn ?? query;
  const withTxFn = options.withTxFn ?? withTx;
  const redisClient = options.redisClient ?? redis;

  router.get('/dlq', async (request, response) => {
    const limit = parseLimit(request.query.limit);
    const before = parseBefore(request.query.before);
    const values: unknown[] = [];
    const where = ["status = 'dead'"];
    if (before) {
      values.push(before);
      where.push(`updated_at < $${values.length}`);
    }
    values.push(limit + 1);
    let result: QueryResult<{
      id: string; type: string; attempts: number; last_error: string | null;
      last_error_kind: 'transient' | 'permanent' | null; updated_at: Date;
    }>;
    try {
      result = await queryFn(
        `SELECT id, type, attempts, last_error, last_error_kind, updated_at
           FROM events WHERE ${where.join(' AND ')}
          ORDER BY updated_at DESC LIMIT $${values.length}`,
        values,
      );
    } catch {
      throw new UnavailableError();
    }
    const rows = result.rows.slice(0, limit);
    return response.json({
      items: rows.map((row) => ({
        event_id: row.id,
        type: row.type,
        attempts: row.attempts,
        last_error: row.last_error,
        last_error_kind: row.last_error_kind,
        updated_at: row.updated_at.toISOString(),
      })),
      next_before: result.rows.length > limit ? rows[rows.length - 1].updated_at.toISOString() : null,
    });
  });

  router.post('/dlq/:eventId/replay', async (request, response) => {
    let result;
    try {
      result = await withTxFn(async (client) => client.query<{ id: string; type: string }>(
        `UPDATE events
            SET status = 'retrying', attempts = 0,
                last_error = NULL, last_error_kind = NULL, updated_at = now()
          WHERE id = $1 AND status = 'dead'
          RETURNING id, type`,
        [request.params.eventId],
      ));
    } catch {
      throw new UnavailableError();
    }
    if (result.rowCount !== 1) throw new ApiError(409, 'NOT_REPLAYABLE', 'Event is not replayable');
    const row = result.rows[0];
    try {
      await redisClient?.xadd(STREAM, '*', 'event_id', row.id, 'type', row.type);
    } catch {
      // Postgres is the source of truth; the sweeper will recover this retrying event.
    }
    return response.status(202).json({ event_id: row.id, status: 'retrying' });
  });
}
