# DATA MODEL

Postgres 16. Raw SQL migrations in `migrations/`. Applied by `scripts/migrate.ts`, which creates and uses a `schema_migrations(name text primary key, applied_at timestamptz default now())` table. Migrations must be safe to run twice (the runner skips applied files).

## migrations/001_init.sql

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL,
  type             text NOT NULL CHECK (type IN ('payment.captured', 'payout.requested')),
  payload          jsonb NOT NULL,
  payload_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'retrying', 'processed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  last_error_kind  text CHECK (last_error_kind IN ('transient', 'permanent')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  CONSTRAINT events_idempotency_key_uniq UNIQUE (idempotency_key)
);

-- Sweeper: stale events that still need work
CREATE INDEX events_pending_idx ON events (updated_at)
  WHERE status IN ('received', 'retrying');

-- DLQ listing
CREATE INDEX events_dead_idx ON events (updated_at DESC)
  WHERE status = 'dead';

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES events (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- Relay: unpublished rows in order
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE wallets (
  merchant_id   text PRIMARY KEY,
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL UNIQUE REFERENCES events (id),
  merchant_id  text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),   -- credit > 0, debit < 0
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_merchant_idx ON ledger_entries (merchant_id);
```

## Why each constraint exists

| Constraint | What it protects |
|---|---|
| `events.idempotency_key` UNIQUE | Layer 1: one event per key, even under parallel requests |
| `events.status` CHECK | Only four legal states |
| `ledger_entries.event_id` UNIQUE | Layer 4: one effect per event, last safety net |
| `wallets.balance_minor >= 0` | A bug can never create negative money (the conditional UPDATE is the normal path, this is the net) |
| `outbox` partial index | Relay scans only unpublished rows |
| `events_pending_idx` | Sweeper finds stale work fast |

## State machine for `events.status`

```
received --(success)--> processed
received --(transient fail, attempts < MAX)--> retrying
received --(permanent fail or attempts >= MAX)--> dead
retrying --(success)--> processed
retrying --(transient fail, attempts < MAX)--> retrying
retrying --(permanent fail or attempts >= MAX)--> dead
dead     --(replay)--> retrying (attempts reset to 0)
processed: terminal
```

`processed` never changes again. Every UPDATE that fails an event includes `AND status <> 'processed'`.

## Key queries (reference)

Insert event (ingest):

```sql
INSERT INTO events (idempotency_key, type, payload, payload_hash)
VALUES ($1, $2, $3, $4)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, status;
```

Lock and load (worker):

```sql
SELECT status, type, payload FROM events WHERE id = $1 FOR UPDATE;
```

Replay (admin):

```sql
UPDATE events
   SET status = 'retrying', attempts = 0, last_error = NULL, last_error_kind = NULL, updated_at = now()
 WHERE id = $1 AND status = 'dead'
RETURNING id, type;
-- if a row returned: XADD to the stream. If none: 409 NOT_REPLAYABLE.
```

Invariant check (used by tests and `GET /v1/wallets/:id?verify=true`):

```sql
SELECT w.merchant_id,
       w.balance_minor,
       COALESCE(SUM(l.amount_minor), 0) AS ledger_sum
  FROM wallets w
  LEFT JOIN ledger_entries l ON l.merchant_id = w.merchant_id
 GROUP BY w.merchant_id, w.balance_minor
HAVING w.balance_minor <> COALESCE(SUM(l.amount_minor), 0);
-- must return zero rows
```

## Implementation notes

- Use a `pg.Pool` (max 20). Always release clients in `finally`.
- Use explicit transactions with `BEGIN` / `COMMIT` / `ROLLBACK` helpers (`withTx(fn)`).
- Map Postgres error code `23505` (unique violation) and `40001`, `40P01` (serialization, deadlock) explicitly. The last two are transient.
- Never log full payloads. Log `event_id` and `type`.
