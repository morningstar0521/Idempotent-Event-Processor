# TESTING

Testing is how this project proves its guarantee. A passing test suite plus a passing chaos run is the product. Read this with `docs/ARCHITECTURE.md` section 8 (failure matrix): every failure row F1 to F16 must map to at least one test below.

> Guarantee under test: at-least-once delivery with idempotent processing. Each unique idempotency key produces at most one business effect.

## 1. Test layers

| Layer | Command | Needs | Runs in CI | Speed |
|---|---|---|---|---|
| Unit | `pnpm test:unit` | Nothing external | Yes | Seconds |
| Integration | `pnpm test:integration` | Real Postgres 16 + Redis 7 | Yes | Under 1 min |
| Chaos lite | `pnpm test:chaos` | Real Postgres + Redis, in-process crash injection | Yes | Under 3 min |
| Chaos full | `pnpm test:chaos:full` | Docker Compose, `docker kill`, `FLUSHALL` | No (local only) | Minutes |
| Load | `pnpm load` | Docker Compose stack + k6 | No (local only) | Minutes |

Rules:

- No mocks for Postgres or Redis in integration and chaos tests. Mocks cannot show lock, constraint, or transaction behavior.
- Unit tests are for pure logic only (hashing, schemas, backoff math, error classification, config).
- Write the test for a behavior before or together with the code (see `docs/BUILD-PLAN.md`).
- A failing invariant is a bug in the code. Never loosen an invariant or a test to get green.

## 2. Test environment

- Env vars (test only, add to `.env.example`): `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/events_test`), `TEST_REDIS_URL` (default `redis://localhost:6379/15`).
- vitest `globalSetup` creates `events_test` if missing and runs migrations once.
- `beforeEach` in integration and chaos tests: `TRUNCATE events, outbox, wallets, ledger_entries RESTART IDENTITY CASCADE` and `FLUSHDB` on Redis DB 15. Never touch DB 0.
- Test config uses short timers so tests are fast: `LOCK_TTL_MS=1500`, `VISIBILITY_TIMEOUT_MS=1500`, `RELAY_POLL_MS=20`, `BACKOFF_BASE_MS=20`, `BACKOFF_CAP_MS=200`, `SWEEP_INTERVAL_MS=500`, `SWEEP_STALE_MS=1000`, `MAX_ATTEMPTS=5`, `MAX_DELIVERIES=5`.
- Each worker, relay, and API in a test is started in-process through the same factory functions the `src/bin/*` entrypoints use. Do not write a second copy of the wiring for tests.

Helpers (`tests/helpers/`):

| Helper | Job |
|---|---|
| `startStack(opts)` | Starts API, relay, N workers in-process. Returns handles with `stop()` and `kill()` (kill = abandon without cleanup, simulates SIGKILL). |
| `postEvent(key, body)` | Calls the API with the API key. Returns status and JSON. |
| `waitForDrain(timeoutMs)` | Polls until no event is `received` or `retrying`, and no outbox row is unpublished. Fails the test on timeout and prints a status histogram. |
| `assertInvariants(expected?)` | Runs all invariants in section 3. |
| `makeEvent(i)` | Builds a deterministic event body (merchant `m_${i % 20}`, amount `100 + (i % 900)`). |

## 3. Invariants (must hold after every integration, chaos, and load run)

`assertInvariants()` runs these after `waitForDrain()`. A single failure fails the test.

| ID | Invariant | Check |
|---|---|---|
| INV-1 | No duplicate effects | `SELECT event_id FROM ledger_entries GROUP BY event_id HAVING count(*) > 1` returns 0 rows |
| INV-2 | Wallet equals ledger | The reconciliation query in `docs/DATA-MODEL.md` returns 0 rows |
| INV-3 | One event per key | `count(events)` equals the number of distinct keys the test sent |
| INV-4 | No lost events | Every event is `processed` or `dead`. None is `received` or `retrying` |
| INV-5 | Effect matches status | `count(ledger_entries)` equals `count(events WHERE status='processed')`. Every `dead` event has no ledger row |
| INV-6 | Outbox complete | Every event has exactly one outbox row, all with `published_at` set |
| INV-7 | Metadata sane | `processed` rows have `processed_at` and `attempts >= 1`. `dead` rows have `last_error` and `last_error_kind` |
| INV-8 | Expected balances | Each merchant balance equals the balance computed from the test's own model of unique events (catches both a double effect and a missing effect). Skipped only when the test has no model |
| INV-9 | Redis is clean | After drain and after `LOCK_TTL_MS` passes: `XPENDING` count is 0, stream length is 0, `events:delayed` size is 0, no `lock:event:*` keys |
| INV-10 | No negative money | `SELECT 1 FROM wallets WHERE balance_minor < 0` returns 0 rows |

INV-8 needs a deterministic model. For chaos and load runs, seed each merchant wallet with a large credit first and wait until it is processed. Then send only payments and small payouts, so no payout can fail with `INSUFFICIENT_FUNDS` because of ordering. The model is then: expected balance = seed + sum of unique payments - sum of unique payouts.

## 4. Unit tests (`tests/unit/`)

| ID | What |
|---|---|
| U-1 | `stableStringify` gives the same output for objects with different key order. Nested objects and arrays are handled |
| U-2 | `payload_hash` is equal for equal `{type, payload}`, different for any changed field or changed type |
| U-3 | Zod schemas: valid payment and payout pass. Reject: unknown field in payload, `amount_minor` of 0, negative, float, string, above 1e12. Reject: currency not `INR`. Reject: `merchant_id` with bad characters or length above 64. Reject: `payout_id` on a payment |
| U-4 | Idempotency-Key validation: missing, empty, 256 chars rejected. 1 and 255 chars accepted |
| U-5 | Backoff: with an injected RNG, delay is always in `[0, min(cap, base * 2^(attempt-1))]`. Cap is respected at high attempt numbers. Never negative, never NaN |
| U-6 | Error classification: `PermanentError` is permanent. Unknown error is transient. pg codes `40001`, `40P01`, lock timeout `55P03`, connection errors are transient |
| U-7 | Config: invalid numbers fail at startup with a clear message. `CHAOS_ENABLED=true` with `NODE_ENV=production` throws |
| U-8 | Chaos module is inert by default: with `CHAOS_ENABLED=false` no hook ever fails, crashes, or pauses, even if probabilities are set |
| U-9 | API key compare uses `timingSafeEqual` and handles different lengths without throwing |
| U-10 | Logger and error responses never include payload contents |

## 5. Integration tests (`tests/integration/`)

### 5.1 API (Flow A)

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-API-1 | New key | 202, `duplicate:false`, 1 event row, 1 outbox row | FR-2, FR-5 |
| I-API-2 | Same key and body twice | Second is 200, `duplicate:true`, same `event_id`, still 1 event and 1 outbox row | FR-2, F3 |
| I-API-3 | Same key, different body | 422 `IDEMPOTENCY_KEY_REUSED`, DB unchanged | FR-3, F2 |
| I-API-4 | **1,000 parallel requests with the same key** | Exactly one 202, 999 are 200 with the same `event_id`. 1 event row, 1 outbox row. After processing, 1 ledger entry | FR-4, F1, AC-1 |
| I-API-5 | 200 parallel requests over 50 distinct keys (4 each) | 50 events, 50 outbox rows, 50 total 202 | FR-4 |
| I-API-6 | Same key, same body, key order differs in JSON | Treated as the same body (200 duplicate) | hash stability |
| I-API-7 | Missing key, empty key, 256-char key | 400 `MISSING_IDEMPOTENCY_KEY` | FR-1 |
| I-API-8 | Invalid body | 400 `VALIDATION_ERROR` with `details` | FR-1 |
| I-API-9 | No or wrong `X-API-Key` | 401 `UNAUTHORIZED`. `/health` still works without a key | API.md |
| I-API-10 | Body above 10kb | Rejected (413 or 400), nothing stored | API.md |
| I-API-11 | Outbox atomicity: force the outbox insert to fail (test hook that throws after the event insert) | No event row and no outbox row exist (one transaction) | FR-5 |
| I-API-12 | Postgres unreachable (use a pool pointed at a closed port) | 503 `UNAVAILABLE`, error shape correct | F14 |
| I-API-13 | `GET /v1/events/:id` | Correct fields, no `payload` in response, 404 for unknown id | FR-14 |
| I-API-14 | `/ready` with Redis down and with Postgres down | 503 naming the failing dependency | FR-16 |

### 5.2 Relay (Flow B)

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-REL-1 | 500 outbox rows, one relay | All published to the stream, all `published_at` set, order by id | FR-6 |
| I-REL-2 | 3 relays in parallel on 500 rows | Each outbox row published one time in the normal path (stream has 500 messages) | FR-6, SKIP LOCKED |
| I-REL-3 | Relay crash after `XADD`, before `COMMIT` (test hook) | Rows are still unpublished, next relay publishes again. Stream has duplicates. After workers drain, INV-1 to INV-10 pass | F4 |
| I-REL-4 | Stream message shape | Has only `event_id` and `type`, no payload | ARCHITECTURE 4 |

### 5.3 Worker (Flow C)

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-WRK-1 | `payment.captured` | Status `processed`, 1 ledger row, wallet credited, message acked and deleted | FR-7 |
| I-WRK-2 | `payout.requested` with enough funds | Wallet debited, ledger row is negative | FR-7 |
| I-WRK-3 | Same event delivered 20 times (XADD the same event_id 20 times) with 5 workers | 1 effect. `duplicates_blocked{layer=lock}` plus `db_status` account for the other 19 | F5, FR-8 |
| I-WRK-4 | Event already `processed`, message arrives again | No-op, acked, `db_status` counter increments | F7, FR-8 |
| I-WRK-5 | Call `applyEffect` twice in two separate transactions for one event id (bypass the status check on purpose) | Second ledger insert conflicts on `event_id`, wallet is not credited twice, `ledger_constraint` counter increments | Layer 4 |
| I-WRK-7 | Effect throws midway (after wallet update, before event status update) | Whole transaction rolled back: no ledger row, no wallet change | Atomicity |
| I-WRK-9 | Ack ordering: assert via a Redis spy that `XACK` is never called before the transaction commit | Pass in both success and failure paths | Ack ordering invariant |
| I-WRK-10 | Lock helper: acquire, second acquire fails, release with wrong token does nothing, release with right token works, TTL is always set | Pass | Lock TTL and ownership invariant |
| I-WRK-11 | Heartbeat renews TTL while handler runs longer than `LOCK_TTL_MS` | Lock key still held after 2x TTL. Stops renewing after handler ends | ARCHITECTURE 5 |

I-WRK-6 and I-WRK-8 require the Phase 4 `handleFailure` implementation and are specified in §5.4.

### 5.4 Retry, DLQ, replay

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-RTY-1 | Transient failure on the first 2 tries, then success (chaos flag with a counter) | Status `processed`, `attempts=3`, delays were scheduled in `events:delayed` | F9, FR-9 |
| I-RTY-2 | Transient failure always | After `MAX_ATTEMPTS` the event is `dead`, `attempts=MAX_ATTEMPTS` | F11, FR-11 |
| I-RTY-3 | Delayed mover moves only due ids, is atomic when 3 movers run together (no id moved twice) | Pass | FR-9 |
| I-RTY-4 | Crash between `ZADD` and `XACK` in `handleFailure` | Duplicate delivery later, ends with 1 effect | ARCHITECTURE 5 |
| I-RTY-5 | `handleFailure` cannot reach Postgres | Message is not acked, stays pending, reaper reclaims it after the timeout | ARCHITECTURE 5 |
| I-RTY-6 | `GET /v1/dlq` | Lists only `dead`, newest first, paging with `before` and `limit` works, limit above 200 is capped | FR-14 |
| I-RTY-7 | Replay a dead event after the cause is fixed (fund the wallet) | 202, status `retrying`, attempts reset, then `processed`, 1 ledger row | AC-7 |
| I-RTY-8 | Replay the same dead event 20 times in parallel | Exactly one 202, the rest 409 `NOT_REPLAYABLE`, one stream message added | F15, FR-15 |
| I-RTY-9 | Replay a `processed` event or an unknown id | 409 `NOT_REPLAYABLE` | API.md |
| I-RTY-10 | Replay when Redis is down at `XADD` time | Event is `retrying` in Postgres. Sweeper picks it up later and it processes | ARCHITECTURE 9 |
| I-WRK-6 | Payout with insufficient funds | Status `dead`, `attempts=1`, `last_error=INSUFFICIENT_FUNDS`, kind `permanent`, no retry scheduled (`events:delayed` empty), message acked | F10, FR-10 |
| I-WRK-8 | Unknown event type or payload that fails the schema at the worker (insert directly into DB) | `dead`, permanent | ARCHITECTURE 7 |

I-RTY-8 is a route-level atomicity test. Its one-202/nineteen-409 result applies when the requests contend on the same `dead` row at one instant. In live operation, if the cause is still present, the worker can re-dead-letter the event between requests, allowing later replay attempts to return 202. Operators must fix the cause before replaying; the ledger constraint prevents duplicate effects.

### 5.5 Reaper and sweeper

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-RPR-1 | A consumer reads a message and never acks (abandoned) | After `VISIBILITY_TIMEOUT_MS` another worker claims it via `XAUTOCLAIM` and processes it. `messages_reclaimed_total` increments | F6, FR-12 |
| I-RPR-2 | Poison message: handler crashes every time | After `MAX_DELIVERIES` the event is `dead` with `last_error='max deliveries exceeded'`, message acked | F12 |
| I-SWP-1 | Insert 100 events as `received` with stale `updated_at` and an empty stream | Sweeper enqueues them, all processed | F13, FR-13 |
| I-SWP-2 | Same, with `retrying` events and an empty `events:delayed` | Recovered and processed | F13 |
| I-SWP-3 | Two relays running sweepers at the same time | Only one holds `pg_try_advisory_lock(7001)` per cycle, no event swept twice in one cycle | ARCHITECTURE 9 |
| I-SWP-4 | Fresh events (not stale) | Sweeper does not touch them | ARCHITECTURE 9 |
| I-SWP-5 | Sweeper bumps `updated_at` | The same event is not swept again in the next cycle | ARCHITECTURE 9 |

### 5.6 Shutdown and metrics

| ID | Scenario | Expected | Maps to |
|---|---|---|---|
| I-SHD-1 | SIGTERM-style `stop()` on a worker with 5 in-flight handlers | In-flight finish and ack, locks released, no new reads, exit within grace | F16, FR-17 |
| I-SHD-2 | Grace time too short | Exit code 1, abandoned work is recovered by another worker, invariants hold | F16 |
| I-MET-1 | `/metrics` after a mixed run | All metric names in ARCHITECTURE section 12 exist, counters match the DB (`events_processed_total` equals processed rows) | FR-16 |

## 6. Chaos tests

Chaos has two modes. Both must end by running `waitForDrain()` and `assertInvariants()` with the INV-8 model.

### 6.1 Chaos hooks (`src/shared/chaos.ts`)

| Hook | Where | Effect when enabled |
|---|---|---|
| `failBeforeEffect()` | Inside the transaction, before `applyEffect` | Throws a transient error with probability `CHAOS_FAIL_PROB` |
| `crashBeforeCommit()` | Inside the transaction, after `applyEffect` | Crash with probability `CHAOS_CRASH_BEFORE_COMMIT_PROB` |
| `crashAfterCommit()` | After commit, before `XACK` | Crash with probability `CHAOS_CRASH_AFTER_COMMIT_PROB` |
| `pause(point)` | `before_tx` (default for the env flag) and `inside_tx` (tests only) | Sleeps `CHAOS_PAUSE_MS` |
| heartbeat switch | Lock heartbeat | `CHAOS_DISABLE_HEARTBEAT=true` stops renewal so the lock expires |

Rules:

- All hooks do nothing unless `CHAOS_ENABLED=true`. With `NODE_ENV=production` and `CHAOS_ENABLED=true` the process exits at startup.
- "Crash" in a real process is `process.kill(process.pid, 'SIGKILL')`.
- For in-process tests, the module exposes `chaos.configure({ crash, pauseAt, failCounter })`. In tests `crash` throws a `SimulatedCrash` error. The handler must not catch it: no ack, no `handleFailure`, no lock release (the lock must expire on its own, like a real crash). The test then calls `kill()` on that worker handle, which stops its loops without cleanup.
- `configure` is a test seam. It must be a no-op unless `NODE_ENV=test`.

### 6.2 Chaos lite scenarios (`tests/chaos/`, run in CI)

Each scenario uses 20 merchants, a seeded wallet, and 300 to 500 events with 50 percent duplicate requests unless stated.

| ID | Scenario | How | Pass condition | Maps to |
|---|---|---|---|---|
| C-1 | Crash before commit | `crashBeforeCommit` prob 0.3, 3 workers, killed workers are replaced | All events end `processed`. No lost events. INV-1 to INV-10 | F6, AC-3 |
| C-2 | Crash after commit, before ack | `crashAfterCommit` prob 0.3 | Redelivered messages are skipped (`db_status` counter above 0). One effect each. INV all | F7, AC-4 |
| C-3a | Lock expiry, pause before tx | Worker A: heartbeat off, pause longer than `LOCK_TTL_MS` before the transaction. Worker B takes the lock and commits. A resumes | A sees `processed`, skips. 1 effect. INV all | F8, AC-6 |
| C-3b | Lock expiry, pause inside tx | A pauses after `FOR UPDATE` for longer than `LOCK_TTL_MS` but shorter than the 5s `lock_timeout`. B takes over | B waits on the row lock, then sees `processed` and skips. 1 effect. If B hits `lock_timeout` it retries as transient and ends skipped. INV all | F8, AC-6 |
| C-4 | Redis wipe mid-run | `FLUSHDB` on the test Redis while events are in flight (stream, delayed, locks all lost) | Sweeper recovers all. Records time to recover. INV all | F13, AC-5 |
| C-5 | Poison message | Handler crashes on one specific event every time | That event becomes `dead` (`max deliveries exceeded`). All others `processed`. Workers keep running | F12 |
| C-6 | Relay crash after XADD | Relay hook crashes before commit, then a new relay starts | Duplicate stream messages exist. INV all | F4 |
| C-7 | Failure storm | `CHAOS_FAIL_PROB=0.3` with `MAX_ATTEMPTS=5` | Mix of retried and `dead` events. Every event is `processed` or `dead`. `dead` events have no ledger row. INV all | F9, F11 |
| C-8 | Combined | Crash before commit 0.1, crash after commit 0.1, fail 0.2, one Redis wipe, 50 percent duplicates, 3 workers | INV all | All |
| C-9 | Same key storm during chaos | 500 parallel requests with one key while workers crash | 1 event, 1 effect | F1 + F6 |

Randomness: print the seed on every run and accept `CHAOS_SEED` to reproduce a failure. Do not retry a failing chaos test to make it green. A flaky chaos test is a real bug (in the code or in the test), so find the cause.

### 6.3 Chaos full scenarios (`pnpm test:chaos:full`, local only)

Runs `docker compose up --scale worker=3`, drives load with k6, and uses the Docker CLI. Script lives in `scripts/chaos/`.

| ID | Scenario | Action | Pass condition |
|---|---|---|---|
| CF-1 | SIGKILL workers | Every 5 s, `docker kill -s KILL` a random worker container, compose restarts it (`restart: unless-stopped`) | 0 lost events, 0 duplicate effects, INV all (AC-3) |
| CF-2 | Redis wipe | `redis-cli FLUSHALL` during load | All events reach `processed` or `dead`. Print recovery time (time from wipe to the last event leaving `received`/`retrying`) (AC-5) |
| CF-3 | Redis restart | `docker restart redis` during load, with AOF on | INV all |
| CF-4 | Postgres restart | `docker restart postgres` during load | API returns 503 while down and recovers. No lost events. INV all (F14) |
| CF-5 | Graceful stop | `docker stop` (SIGTERM) a worker mid-load | Exits 0 within grace time, no lost events (F16) |
| CF-6 | Combined | CF-1 and CF-2 together | INV all |

Output: a table per scenario with pass or fail, counts, and recovery time. It goes into `docs/RESULTS.md` under "Chaos full".

## 7. Load test

Tool: k6. Scripts: `scripts/load/run.ts` (orchestrates), `scripts/load/k6-ingest.js` (k6 script), `scripts/report.ts` (builds `docs/RESULTS.md`). Command: `pnpm load`.

### 7.1 Flow of `pnpm load`

1. `run.ts` checks the stack is up (`/ready`), generates `scripts/load/plan.json` (gitignored): a run id, a list of unique events, a shuffled list of requests where each unique event appears once or twice (`DUP_RATIO`, default 0.5), and the expected balance per merchant (the INV-8 model).
2. Seeds merchant wallets with large credits through the API and waits for them to be processed.
3. Scrapes `/metrics` from API, relay, and worker (before snapshot).
4. Runs k6 with `--summary-export`.
5. Waits for drain (`waitForDrain` with a long timeout).
6. Scrapes `/metrics` again (after snapshot), runs the invariants, and calls `report.ts`.

### 7.2 k6 scenarios

| Scenario | Purpose | Shape |
|---|---|---|
| `smoke` | Sanity | 1 VU, 10 requests |
| `dup_heavy` (the main one) | Throughput and latency with 200 percent duplicates: each unique event is sent 3 times | `constant-arrival-rate` over the shuffled request list. Rates are set in the script header and recorded in RESULTS.md |
| `same_key_storm` | 1,000 parallel requests with one key (AC-1) | `shared-iterations`, 1,000 VUs, 1,000 iterations |

Each request sets a fresh `Idempotency-Key` per unique event. Duplicate requests reuse the key and the identical body. k6 checks: status is 200 or 202, and `event_id` is present. A 5xx or a check failure is a failure of the run.

### 7.3 What the report must contain (`docs/RESULTS.md`)

Everything in the file comes from the scripts. The report script must refuse to write a metric it could not measure.

| Section | Content | Source |
|---|---|---|
| Header | Date, git SHA, machine (CPU, RAM, OS), Docker versions, worker count, all config values | script |
| Requests | Total sent, unique keys, created (202), duplicate (200), errors | k6 summary and DB |
| Throughput | Ingest requests per second, and processed events per second (processed count divided by time from first `created_at` to last `processed_at`) | k6 and DB |
| API latency | p50, p95, p99 per scenario | k6 |
| End-to-end latency | p50, p95, p99 of `processed_at - created_at` | DB query |
| Duplicates blocked | By layer: `api`, `lock`, `db_status`, `ledger_constraint` (after minus before) | Prometheus |
| Retries and dead | `events_retried_total`, `events_dead_total` | Prometheus |
| Invariants | Table of INV-1 to INV-10 with pass or fail | `assertInvariants` |
| Chaos full | Table from section 6.3, if it was run | chaos script |
| Notes | Machine is a single box, numbers are not a capacity claim | static text |

Gates (a run fails if any is true): any invariant fails, any event ends neither `processed` nor `dead`, duplicate effects above 0, any 5xx. No latency or throughput threshold is a gate until a first real run exists. After that, record the numbers in RESULTS.md and the README. Never write a number into any doc by hand.

## 8. Mapping: failure matrix to tests

| Row | Tests | Passing evidence |
|---|---|---|
| F1 | I-API-4, I-API-5, C-9 | one event, one ledger row, API duplicate count 499 |
| F2 | I-API-3 |
| F3 | I-API-2 |
| F4 | I-REL-3, C-6 | relay hook counter and duplicate stream message counter |
| F5 | I-WRK-3 |
| F6 | I-RPR-1, C-1, CF-1 | reclaimed messages and all final statuses |
| F7 | I-WRK-4, C-2 | `duplicates_blocked{layer="db_status"}` above zero |
| F8 | I-WRK-11, C-3a, C-3b | lock recovery and row-lock wait counters above zero |
| F9 | I-RTY-1, C-7 | retry counter above zero and final-state invariant |
| F10 | I-WRK-6 |
| F11 | I-RTY-2, C-7 | max-attempt dead counter above zero and no dead ledger |
| F12 | I-RPR-2, C-5 | one max-delivery dead event and counter delta 1 |
| F13 | I-SWP-1, I-SWP-2, C-4, CF-2 | sweeper counter above zero and measured recovery time |
| F14 | I-API-12, I-RTY-5, CF-4 | 503 during dependency outage and no lost events |
| F15 | I-RTY-8 |
| F16 | I-SHD-1, I-SHD-2, CF-5 | graceful exit and final-state invariant |

Invariant coverage in the chaos suite. Each listed C test calls `assertInvariants`; INV-9 is intentionally checked only at end-of-run after the cleanup TTL:

| Invariant | Tests that assert it |
|---|---|
| INV-1 | C-1, C-2, C-6, C-9 |
| INV-2 | C-1, C-2, C-4, C-8 |
| INV-3 | C-1, C-2, C-7, C-9 |
| INV-4 | C-1, C-4, C-7, C-8 |
| INV-5 | C-1, C-2, C-5, C-7 |
| INV-6 | C-1, C-3a, C-4, C-8 |
| INV-7 | C-1, C-2, C-5, C-7 |
| INV-8 | C-1, C-2, C-3a, C-8 |
| INV-9 | C-1, C-2, C-3a, C-4, C-8, end-of-run only |
| INV-10 | C-1, C-2, C-4, C-7 |

## 9. Mapping: acceptance criteria to tests

| AC (PRD section 9) | Proof |
|---|---|
| 1. 1,000 parallel same-key requests give 1 event and 1 ledger entry | I-API-4, `same_key_storm` |
| 2. 200 percent duplicate load ends with invariants passing | `dup_heavy` plus INV-1 to INV-10 |
| 3. SIGKILL workers loses nothing and doubles nothing | C-1, CF-1 |
| 4. Crash after commit, before ack, is skipped on redelivery | C-2, I-WRK-4 |
| 5. Redis wipe loses nothing | C-4, CF-2 |
| 6. Expired lock cannot cause a double effect | C-3a, C-3b |
| 7. Permanent failure goes `dead` with 1 attempt, replay succeeds | I-WRK-6, I-RTY-7 |
| 8. RESULTS.md from real runs | `pnpm load` output |
| 9. README readable in 2 minutes | Manual review (Phase 8 checklist) |
| 10. EC2 deploy (stretch) | Manual smoke test, section 10 |

## 10. CI and manual checks

CI (GitHub Actions, on every push and pull request), with Postgres 16 and Redis 7 as service containers:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test:unit`
5. `pnpm migrate`
6. `pnpm test:integration`
7. `pnpm test:chaos`
8. `docker build .` (image builds)
9. A grep step that fails the build if the prohibited guarantee wording or the long dash character appears in `src/`, `docs/`, `README.md`, `tests/`, or `scripts/`.

Manual smoke test after any deploy (EC2 or local compose):

1. `curl /ready` returns ready.
2. POST the same event twice with one key: 202 then 200 with the same `event_id`.
3. `GET /v1/wallets/m_1?verify=true` shows `verified: true`.
4. Post a payout larger than the balance, see it in `GET /v1/dlq`, fund the wallet, replay, see it processed.
5. `docker kill -s KILL` a worker and watch the stream drain.

## 11. Definition of done for tests

- Every row in sections 4, 5, and 6.2 exists as a named test (use the ID in the test title so failures are traceable).
- Every failure row F1 to F16 has at least one passing test.
- The three Never-cut items from the PRD (invariants, chaos test, sweeper, row-lock plus status-check transaction) each have passing tests in CI.
- Test titles are readable sentences, not code names.
