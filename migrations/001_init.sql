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

CREATE INDEX events_pending_idx ON events (updated_at)
  WHERE status IN ('received', 'retrying');

CREATE INDEX events_dead_idx ON events (updated_at DESC)
  WHERE status = 'dead';

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES events (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

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
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_merchant_idx ON ledger_entries (merchant_id);

