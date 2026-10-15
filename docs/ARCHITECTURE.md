# ARCHITECTURE

## 1. Overview

Three small processes share one Postgres and one Redis.

```mermaid
flowchart LR
  P[Producer] -->|POST /v1/events + Idempotency-Key| API
  API -->|1 tx: event + outbox| PG[(Postgres)]
  RELAY -->|poll outbox SKIP LOCKED| PG
  RELAY -->|XADD| RS[(Redis Stream events:stream)]
  RS -->|XREADGROUP| W[Worker x N]
  W -->|lock per event| RL[(Redis lock)]
  W -->|1 tx: row lock + status check + effect| PG
  W -->|XACK + XDEL after commit| RS
  W -->|retry: ZADD| RZ[(Redis ZSET events:delayed)]
  RZ -->|delayed mover| RS
  SW[Sweeper in relay] -->|stale events| PG
  SW -->|XADD| RS
```

| Process | Entry file | Job |
|---|---|---|
| api | `src/bin/api.ts` | Accept events, idempotency check, admin endpoints, metrics |
| relay | `src/bin/relay.ts` | Outbox to stream publisher, plus the sweeper |
| worker | `src/bin/worker.ts` | Consume stream, process, retry, reap, move delayed |

## 2. Three layers of duplicate protection

| Layer | Where | What stops the duplicate | Metric label |
|---|---|---|---|
| 1. API | `events.idempotency_key` UNIQUE | Second request returns the stored event | `layer="api"` |
| 2. Lock | Redis `SET lock:event:<id> NX PX` | Second concurrent worker skips (efficiency only) | `layer="lock"` |
| 3. DB status | `SELECT ... FOR UPDATE` then check `status` | Redelivery of an already processed event is a no-op | `layer="db_status"` |
| 4. DB constraint | `ledger_entries.event_id` UNIQUE | Last safety net, even if layers 1 to 3 had a bug | `layer="ledger_constraint"` |

Correctness depends on layers 1, 3, and 4 only. Layer 2 can disappear and the system stays correct (just slower, with more contention).

## 3. Flow A: ingest (API)

1. Validate header `Idempotency-Key` (1 to 255 chars) and body (Zod).
2. Compute `payload_hash = sha256(stableStringify({type, payload}))`.
3. Start transaction:
   - `INSERT INTO events (...) VALUES (...) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, status`
   - If a row was returned (new): `INSERT INTO outbox (event_id) VALUES ($id)`. Commit. Respond 202.
4. If no row was returned (key exists): `SELECT id, status, payload_hash FROM events WHERE idempotency_key = $1`.
   - If `payload_hash` differs: respond 422 `IDEMPOTENCY_KEY_REUSED`.
   - Else respond 200 with `duplicate: true` and the current status. (In-flight duplicates are fine: just return the current status.)
5. Concurrent identical requests: the unique constraint makes exactly one insert win. The others fall to step 4.

Why the event and outbox rows share one transaction: either both exist or neither does. This closes the "saved but never queued" gap.

## 4. Flow B: relay (outbox to stream)

Loop every `RELAY_POLL_MS`:

```
BEGIN
  SELECT id, event_id FROM outbox
   WHERE published_at IS NULL
   ORDER BY id LIMIT RELAY_BATCH
   FOR UPDATE SKIP LOCKED
  for each row: XADD events:stream * event_id <uuid> type <type>
  UPDATE outbox SET published_at = now() WHERE id = ANY($ids)
COMMIT
```

- `SKIP LOCKED` lets many relays run in parallel without double-picking.
- If the relay crashes after `XADD` but before `COMMIT`, rows get published again. That creates duplicate stream messages, which is fine: the worker is idempotent. This is the "at-least-once" part, stated on purpose.
- The stream message carries only `event_id` and `type`. The worker loads the payload from Postgres (single source of truth, small messages).

## 5. Flow C: worker handle (the core)

Consumer group `workers`, stream `events:stream`, consumer name `<hostname>-<pid>`. Create the group at startup with `XGROUP CREATE ... MKSTREAM` and ignore `BUSYGROUP`.

Pseudo-code:

```
handle(msg):
  id = msg.event_id
  lock = tryAcquire("lock:event:" + id, LOCK_TTL_MS)          // SET NX PX, random token
  if !lock:
     metrics.duplicates_blocked{layer="lock"}++
     xack_and_del(msg)       // safe: the lock holder owns a live delivery
     return
  hb = startHeartbeat(lock)  // renews TTL every LOCK_TTL_MS/3 with Lua compare-and-pexpire
  try:
     outcome = processInTx(id)         // see below
     chaos.crashAfterCommit()          // test hook only
     xack_and_del(msg)
  catch err:
     handleFailure(id, err, msg)
  finally:
     hb.stop(); release(lock)          // Lua compare-and-delete
```

`processInTx(id)`:

```
BEGIN
  SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s';
  row = SELECT status, type, payload FROM events WHERE id = $1 FOR UPDATE
  if row.status in ('processed','dead'):
       COMMIT; metrics.duplicates_blocked{layer="db_status"}++; return 'skipped'
  chaos.failBeforeEffect(); chaos.crashBeforeCommit()      // test hooks only
  applyEffect(row.type, row.payload, id)                   // see section 6
  UPDATE events SET status='processed', processed_at=now(), updated_at=now(),
                    attempts = attempts + 1 WHERE id = $1
COMMIT
return 'applied'
```

If a lost-lock flag is set (heartbeat failed) right before COMMIT, ROLLBACK and do not ack. The message will be redelivered or reclaimed. This is a best-effort optimization. Correctness still comes from the row lock and status check.

`handleFailure(id, err, msg)`:

```
kind = classify(err)                               // 'transient' | 'permanent'
BEGIN
  UPDATE events
     SET attempts = attempts + 1,
         last_error = $msg, last_error_kind = $kind, updated_at = now(),
         status = CASE WHEN $kind = 'permanent' OR attempts + 1 >= MAX_ATTEMPTS
                       THEN 'dead' ELSE 'retrying' END
   WHERE id = $1 AND status <> 'processed'
   RETURNING status, attempts
COMMIT
if no row returned: xack_and_del(msg); return          // already processed by someone else
if status == 'retrying':
     delay = random(0, min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(attempts-1)))   // full jitter
     ZADD events:delayed (now + delay) id               // FIRST
     xack_and_del(msg)                                  // THEN ack (crash between = duplicate, which is safe)
if status == 'dead':
     xack_and_del(msg)
```

If `handleFailure` itself fails (for example Postgres is down), do NOT ack. The message stays pending and the reaper reclaims it after the visibility timeout.

## 5. Flow D: reliability loops (inside every worker process)

| Loop | Interval | What it does |
|---|---|---|
| Delayed mover | 500 ms | Lua script: take due ids from `events:delayed` (score <= now, limit 100), `XADD` each to the stream, `ZREM` them. Atomic. |
| Reaper | 5 s | `XAUTOCLAIM events:stream workers <me> VISIBILITY_TIMEOUT_MS 0 COUNT 50`. Process claimed messages with the same `handle`. If a message's delivery count (from `XPENDING`) exceeds `MAX_DELIVERIES`, mark the event `dead` with `last_error = 'max deliveries exceeded'` and ack it. This stops a poison message that crashes workers forever. |

## 6. Business effects (`src/domain/effects.ts`)

`payment.captured` `{merchant_id, amount_minor > 0, currency: 'INR', payment_id}`:

```
INSERT INTO ledger_entries (event_id, merchant_id, amount_minor) VALUES ($event, $m, +$amt)
  ON CONFLICT (event_id) DO NOTHING RETURNING id
if inserted:
  INSERT INTO wallets (merchant_id, balance_minor) VALUES ($m, $amt)
    ON CONFLICT (merchant_id) DO UPDATE SET balance_minor = wallets.balance_minor + EXCLUDED.balance_minor, updated_at = now()
else: metrics.duplicates_blocked{layer="ledger_constraint"}++
```

`payout.requested` `{merchant_id, amount_minor > 0, currency: 'INR', payout_id}`:

```
UPDATE wallets SET balance_minor = balance_minor - $amt, updated_at = now()
 WHERE merchant_id = $m AND balance_minor >= $amt RETURNING balance_minor
if 0 rows: throw PermanentError('INSUFFICIENT_FUNDS')
INSERT INTO ledger_entries (event_id, merchant_id, amount_minor) VALUES ($event, $m, -$amt)
  ON CONFLICT (event_id) DO NOTHING
```

All of this runs inside the `processInTx` transaction. If the ledger insert or the wallet update fails, everything rolls back.

## 7. Error classification

| Kind | Examples | Behavior |
|---|---|---|
| permanent | `INSUFFICIENT_FUNDS`, unknown event type, payload fails schema at worker | No retry. Status `dead`, attempts = 1. |
| transient | DB timeout, lock timeout, connection reset, serialization or deadlock error, anything unexpected | Retry with backoff up to `MAX_ATTEMPTS`. |

Default for unknown errors is transient.

## 8. Failure matrix (the heart of the project)

| # | What goes wrong | What happens | Why it is safe |
|---|---|---|---|
| F1 | Client sends the same key twice in parallel | One insert wins, others read it and return it | UNIQUE on `idempotency_key` |
| F2 | Client reuses a key with a different body | 422, nothing changes | `payload_hash` compare |
| F3 | API crashes after commit, before responding | Client retries same key, gets 200 duplicate | Event is already stored |
| F4 | Relay crashes after XADD, before commit | Outbox rows republished, duplicate stream messages | Worker is idempotent |
| F5 | Two workers get the same event | One gets the lock, the other acks and skips | Lock is efficiency, DB is correctness |
| F6 | Worker crashes before commit | Transaction rolls back, message stays pending, reaper reclaims after timeout | No effect was committed |
| F7 | Worker crashes after commit, before ack | Message redelivered, status is `processed`, skipped, acked | Status check under row lock |
| F8 | Lock expires while worker A is slow, worker B takes over | Row lock plus status check: whoever commits first wins, the other sees `processed` or waits on the row lock then skips | DB row lock is the arbiter, not Redis |
| F9 | Transient failure (DB hiccup) | Status `retrying`, ZADD with backoff, redelivered later | Attempts counted in DB |
| F10 | Permanent failure | Status `dead`, no retry, visible in DLQ | Classified error |
| F11 | Retries exhausted | Status `dead` | `attempts >= MAX_ATTEMPTS` |
| F12 | Poison message crashes workers repeatedly | After `MAX_DELIVERIES` it is marked `dead` | Delivery count cap |
| F13 | Redis wiped or restarted without persistence | Sweeper re-enqueues stale `received` and `retrying` events from Postgres | Postgres is the truth |
| F14 | Postgres down | API returns 503, workers cannot ack so messages stay pending, relay waits | No ack before commit |
| F15 | Replay called twice on a dead event | Only the first `UPDATE ... WHERE status='dead'` wins | Conditional update |
| F16 | Worker gets SIGTERM | Stops reading, finishes in-flight, releases locks, exits | Graceful shutdown |

## 9. Sweeper (Redis loss recovery)

Runs inside the relay process every `SWEEP_INTERVAL_MS`, guarded by `pg_try_advisory_lock(7001)` so only one runs at a time.

```
UPDATE events SET updated_at = now()
 WHERE id IN (
   SELECT id FROM events
    WHERE status IN ('received','retrying') AND updated_at < now() - SWEEP_STALE_MS
    ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED)
RETURNING id, type
-> XADD each to events:stream
```

Bumping `updated_at` stops the same events from being swept again every cycle. If the stream was not actually lost, the extra messages are duplicates and are safely skipped.

## 10. Redis keys

| Key | Type | Use |
|---|---|---|
| `events:stream` | Stream | Main delivery channel, group `workers` |
| `events:delayed` | ZSET | Retry schedule, score = ready time in ms |
| `lock:event:<event_id>` | String | Per-event lock, value = random token, TTL = `LOCK_TTL_MS` |

After `XACK`, always `XDEL` the message id. Do not use `XTRIM`: it can delete messages that are still pending.

## 11. Configuration (`.env.example`)

```
NODE_ENV=development
PORT=3000
API_KEY=change-me
DATABASE_URL=postgres://postgres:postgres@localhost:5432/events
REDIS_URL=redis://localhost:6379

MAX_ATTEMPTS=5
BACKOFF_BASE_MS=500
BACKOFF_CAP_MS=30000
LOCK_TTL_MS=30000
VISIBILITY_TIMEOUT_MS=30000
MAX_DELIVERIES=10
WORKER_CONCURRENCY=10
RELAY_BATCH=100
RELAY_POLL_MS=100
SWEEP_INTERVAL_MS=30000
SWEEP_STALE_MS=120000
SHUTDOWN_GRACE_MS=15000

CHAOS_ENABLED=false
CHAOS_FAIL_PROB=0
CHAOS_CRASH_BEFORE_COMMIT_PROB=0
CHAOS_CRASH_AFTER_COMMIT_PROB=0
CHAOS_DISABLE_HEARTBEAT=false
CHAOS_PAUSE_MS=0
```

Crash means `process.kill(process.pid, 'SIGKILL')`. `CHAOS_ENABLED=true` with `NODE_ENV=production` must exit at startup with an error.

## 12. Observability

Prometheus metrics at `/metrics` on the API. Workers and relay expose `/metrics` on `METRICS_PORT` (default 9101 for worker, 9102 for relay).

| Metric | Type | Labels |
|---|---|---|
| `events_received_total` | counter | `result` = created / duplicate / reused |
| `duplicates_blocked_total` | counter | `layer` = api / lock / db_status / ledger_constraint |
| `events_processed_total` | counter | none |
| `events_failed_total` | counter | `kind` = transient / permanent |
| `events_retried_total` | counter | none |
| `events_dead_total` | counter | `reason` |
| `messages_reclaimed_total` | counter | none |
| `sweeper_requeued_total` | counter | none |
| `processing_duration_seconds` | histogram | none |
| `api_request_duration_seconds` | histogram | `route`, `status` |
| `stream_length` | gauge | none |
| `stream_pending` | gauge | none |
| `delayed_size` | gauge | none |

Logs: pino JSON. Always include `service`, `event_id`, `msg_id`, `attempt` when known.

## 13. Graceful shutdown

On SIGTERM or SIGINT: stop reading new messages, wait up to `SHUTDOWN_GRACE_MS` for in-flight handlers, release held locks, close Postgres and Redis, exit 0. If the grace time passes, exit 1. In-flight work that is abandoned is safe (see F6 and F7).

## 14. Known limitations (state these in the README)

- No ordering guarantee across events. A `payout.requested` that arrives before its `payment.captured` fails permanently and can be replayed from the DLQ.
- Idempotency keys are kept forever in v1.
- Single Postgres and single Redis (no failover).
- Redis Streams are not a replacement for a replicated log like Kafka. This is a deliberate scope choice.
