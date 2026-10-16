import type { PoolClient } from 'pg';
import { PermanentError } from './errors.js';
import { eventSchema } from './schemas.js';
import { duplicatesBlocked } from '../shared/metrics.js';

export async function applyEffect(client: PoolClient, type: string, payload: unknown, eventId: string): Promise<void> {
  const event = eventSchema.safeParse({ type, payload });
  if (!event.success) throw new PermanentError('INVALID_EVENT_PAYLOAD');

  if (event.data.type === 'payment.captured') {
    const inserted = await client.query(
      `INSERT INTO ledger_entries (event_id, merchant_id, amount_minor)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, event.data.payload.merchant_id, event.data.payload.amount_minor],
    );
    if (inserted.rowCount === 0) {
      duplicatesBlocked.inc({ layer: 'ledger_constraint' });
      return;
    }
    await client.query(
      `INSERT INTO wallets (merchant_id, balance_minor)
       VALUES ($1, $2)
       ON CONFLICT (merchant_id) DO UPDATE
       SET balance_minor = wallets.balance_minor + EXCLUDED.balance_minor,
           updated_at = now()`,
      [event.data.payload.merchant_id, event.data.payload.amount_minor],
    );
    return;
  }

  const wallet = await client.query(
    `UPDATE wallets
     SET balance_minor = balance_minor - $1, updated_at = now()
     WHERE merchant_id = $2 AND balance_minor >= $1
     RETURNING balance_minor`,
    [event.data.payload.amount_minor, event.data.payload.merchant_id],
  );
  if (wallet.rowCount === 0) throw new PermanentError('INSUFFICIENT_FUNDS');
  await client.query(
    `INSERT INTO ledger_entries (event_id, merchant_id, amount_minor)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, event.data.payload.merchant_id, -event.data.payload.amount_minor],
  );
}
