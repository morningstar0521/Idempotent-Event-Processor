import type { Router } from 'express';
import { eventSchema, validateIdempotencyKey, type EventInput } from '../../domain/schemas.js';
import { ApiError, IdempotencyKeyReusedError, MissingIdempotencyKeyError, NotFoundError, UnavailableError, ValidationError } from '../../domain/errors.js';
import { withTx, query } from '../../shared/db.js';
import { payloadHash } from '../../shared/hash.js';
import { duplicatesBlocked, eventsReceived } from '../../shared/metrics.js';

type EventRow = { id: string; status: string; payload_hash: string };

export interface EventRouteOptions {
  failOutboxInsert?: boolean;
  queryFn?: typeof query;
  withTxFn?: typeof withTx;
}

export function registerEventRoutes(router: Router, options: EventRouteOptions = {}): void {
  const queryFn = options.queryFn ?? query;
  const withTxFn = options.withTxFn ?? withTx;
  router.post('/events', async (request, response) => {
    let idempotencyKey: string;
    try {
      idempotencyKey = validateIdempotencyKey(request.header('Idempotency-Key'));
    } catch {
      throw new MissingIdempotencyKeyError();
    }

    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map(({ code, message, path }) => ({ code, message, path })));
    const event: EventInput = parsed.data;
    const hash = payloadHash(event.type, event.payload);

    try {
      const result = await withTxFn(async (client) => {
        const inserted = await client.query<{ id: string; status: string }>(
          `INSERT INTO events (idempotency_key, type, payload, payload_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, status`,
          [idempotencyKey, event.type, event.payload, hash],
        );
        if (inserted.rowCount === 1) {
          if (options.failOutboxInsert) throw new Error('forced outbox insert failure');
          await client.query('INSERT INTO outbox (event_id) VALUES ($1)', [inserted.rows[0].id]);
          return { id: inserted.rows[0].id, status: inserted.rows[0].status, duplicate: false };
        }
        const existing = await client.query<EventRow>(
          'SELECT id, status, payload_hash FROM events WHERE idempotency_key = $1',
          [idempotencyKey],
        );
        if (existing.rowCount !== 1) throw new UnavailableError();
        const row = existing.rows[0];
        if (row.payload_hash !== hash) throw new IdempotencyKeyReusedError();
        return { id: row.id, status: row.status, duplicate: true };
      });

      eventsReceived.inc({ result: result.duplicate ? 'duplicate' : 'created' });
      if (result.duplicate) duplicatesBlocked.inc({ layer: 'api' });
      return response.status(result.duplicate ? 200 : 202).json({
        event_id: result.id,
        status: result.status,
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        eventsReceived.inc({ result: 'reused' });
        throw error;
      }
      if (error instanceof UnavailableError) throw error;
      if (error instanceof ApiError) throw error;
      throw new UnavailableError();
    }
  });

  router.get('/events/:id', async (request, response) => {
    let result;
    try {
      result = await queryFn<{
      id: string;
      idempotency_key: string;
      type: string;
      status: string;
      attempts: number;
      last_error: string | null;
      last_error_kind: string | null;
      created_at: Date;
      processed_at: Date | null;
    }>(
      `SELECT id, idempotency_key, type, status, attempts, last_error, last_error_kind, created_at, processed_at
       FROM events WHERE id = $1`,
      [request.params.id],
      );
    } catch {
      throw new UnavailableError();
    }
    if (result.rowCount !== 1) throw new NotFoundError();
    const event = result.rows[0];
    return response.json({
      event_id: event.id,
      idempotency_key: event.idempotency_key,
      type: event.type,
      status: event.status,
      attempts: event.attempts,
      last_error: event.last_error,
      last_error_kind: event.last_error_kind,
      created_at: event.created_at.toISOString(),
      processed_at: event.processed_at?.toISOString() ?? null,
    });
  });

  router.get('/wallets/:merchantId', async (request, response) => {
    const verify = request.query.verify === 'true';
    let result;
    try {
      result = await queryFn<{
        merchant_id: string;
        balance_minor: string;
        ledger_entries: string;
        ledger_sum_minor: string;
      }>(
        `SELECT w.merchant_id, w.balance_minor, COUNT(l.id) AS ledger_entries,
                COALESCE(SUM(l.amount_minor), 0) AS ledger_sum_minor
         FROM wallets w
         LEFT JOIN ledger_entries l ON l.merchant_id = w.merchant_id
         WHERE w.merchant_id = $1
         GROUP BY w.merchant_id, w.balance_minor`,
        [request.params.merchantId],
      );
    } catch {
      throw new UnavailableError();
    }
    if (result.rowCount !== 1) throw new NotFoundError();
    const wallet = result.rows[0];
    const balance = Number(wallet.balance_minor);
    const body: Record<string, unknown> = {
      merchant_id: wallet.merchant_id,
      balance_minor: balance,
      ledger_entries: Number(wallet.ledger_entries),
    };
    if (verify) {
      const ledgerSum = Number(wallet.ledger_sum_minor);
      body.verified = balance === ledgerSum;
      body.ledger_sum_minor = ledgerSum;
    }
    return response.json(body);
  });
}
