# DECISIONS

Each decision is final for v1. The agent must not reverse any of them. If a decision looks wrong while building, write the problem in `docs/OPEN-QUESTIONS.md` and ask. Format: decision, why, rejected options, cost we accept.

> Guarantee: at-least-once delivery with idempotent processing. Each unique idempotency key produces at most one business effect.

## A. Core principles

### D1. Postgres is the source of truth, Redis is a helper
- Why: Postgres gives transactions, constraints, and row locks. These are what make an effect happen once. Redis can lose data (restart, flush, failover) and gives no cross-store transaction with Postgres.
- Rejected: storing event state in Redis only (a wipe loses events).
- Cost: every event needs a Postgres write before any queueing, which limits peak throughput. We accept it (NFR-1: correctness over speed).

### D2. Say "at-least-once delivery with idempotent processing"
- Why: a message system cannot honestly promise that a message is delivered once. The network can lose an ack, and a worker can crash after the effect. What we can promise is that duplicate deliveries do not repeat the effect.
- Rule: the banned phrase from AGENTS.md never appears in code, docs, logs, commits, or the README. CI greps for it.
- Interview line: "Delivery is at-least-once. The effect happens at most once per key because the database enforces it."

### D3. Three correctness layers in Postgres, one efficiency layer in Redis
- Correctness: (1) `events.idempotency_key` UNIQUE, (2) `SELECT ... FOR UPDATE` plus status check in one transaction, (3) `ledger_entries.event_id` UNIQUE.
- Efficiency only: the Redis lock. It reduces wasted work and DB contention.
- Why: any one layer can have a bug. The constraint on `ledger_entries` is the net under all of them.
- Note: `ARCHITECTURE.md` section 2 has a heading that says "Three layers" above a table with four rows. Resolution: the correctness story is three layers (API key constraint, row lock plus status, ledger constraint). The lock is a fourth helper. When asked for "the three layers" use these three.

### D4. The Redis lock is for efficiency, never for correctness
- Why: a lock with a TTL can always expire while the holder is slow (GC pause, network stall, DB wait). Any design that needs the lock to be perfect is wrong. Here the row lock and status check decide, so an expired lock is harmless (failure F8).
- Rejected: Redlock or fencing tokens. The extra complexity adds nothing, because Postgres already acts as the arbiter.
- Rules: always a TTL, token value, release by Lua compare-and-delete, heartbeat renews with Lua compare-and-pexpire.

## B. Ingest and outbox

### D5. Idempotency key is a unique column, enforced by `INSERT ... ON CONFLICT DO NOTHING`
- Why: the database serializes concurrent inserts. A check-then-insert in application code has a race. The insert-first pattern has none.
- Rejected: checking Redis first (race, and lost on wipe), `SELECT` then `INSERT` (race).
- Cost: keys are kept forever in v1 (no expiry). Documented as a known limitation and future work.

### D6. A reused key with a different body is a 422, not a silent success
- Why: it is a client bug. Returning the old result would hide it. Compared by `payload_hash` of `{type, payload}` using a stable (sorted-key) JSON string.
- Cost: hashing on every request (cheap).

### D7. Outbox pattern, event row and outbox row in one transaction
- Why: writing to Postgres and then publishing to Redis are two separate systems. If the process crashes between them, the event is saved but never queued (or queued but not saved). One transaction for event plus outbox row removes that gap. A relay publishes later.
- Rejected: publishing from the API after commit (gap on crash), publishing before commit (a message for an event that does not exist), two-phase commit (not available across Postgres and Redis).
- Cost: one extra hop, so a few ms of added latency, and the relay is another process.

### D8. Relay uses `FOR UPDATE SKIP LOCKED` and publishes before marking
- Why: many relays can run safely without double-picking rows. Publishing first and marking after means a crash causes a duplicate message, never a lost one. A duplicate is safe because the worker is idempotent.
- Rejected: marking first then publishing (a crash loses the message).

### D9. Stream messages carry only `event_id` and `type`
- Why: Postgres holds the payload, so there is one copy of the truth, messages stay small, and a stale message can never carry stale data.

## C. Queue and workers

### D10. Redis Streams with a consumer group (not BullMQ, not Kafka, not a plain List)
- Why Streams: built-in consumer groups, a pending entries list (so crashed work is visible and reclaimable), `XAUTOCLAIM`, and delivery counts. This is the closest Redis feature to what Kafka offers, at a fraction of the setup cost.
- Rejected: Kafka (setup time, adds little to what the project demonstrates, and the brief says to skip it first), BullMQ (hides the mechanics we want to show, and AGENTS.md bans it), `LIST` with `BRPOPLPUSH` (no consumer groups or delivery counts).
- Cost: Redis is not a replicated log. Documented as a limitation. Redis Streams are not durable like Kafka, and that is why Postgres plus the sweeper exists.
- Consumer group creation uses start id `0` (not `$`), so messages added before the group exists are not skipped. Ignore `BUSYGROUP`.

### D11. Ack only after the database outcome is committed, then delete the message
- Why: ack before commit loses work when the worker crashes. Ack after commit may repeat a delivery, and repeats are safe.
- `XACK` is always followed by `XDEL`. `XTRIM` is not used, because it can remove messages that are still pending.

### D12. The processing transaction: row lock, status check, effect, status update, commit
- Why: `SELECT ... FOR UPDATE` makes concurrent workers for the same event queue up on the row. The first to commit sets `processed`. The next one then reads `processed` and skips. This works even if the Redis lock failed completely.
- Rejected: `SERIALIZABLE` isolation (retries and aborts under contention, harder to explain), advisory locks per event (same effect, but less visible and not tied to the row), optimistic version column (needs retry logic everywhere).
- `lock_timeout = 5s` and `statement_timeout = 10s` are set with `SET LOCAL`, so a stuck transaction cannot hold the row forever. Hitting them is a transient error.

### D13. A worker that fails to get the Redis lock acks and drops the message
- Why: another worker holds a live delivery for this event. Re-queueing would only spin.
- Edge case (accepted, documented): worker A holds the lock and crashes before commit, after a reclaim already gave the message to B, which dropped it. The message is gone from the stream, but the event is still `received` or `retrying` in Postgres. The sweeper re-enqueues it after `SWEEP_STALE_MS`. Cost: a delay, never a loss.

### D14. Lock heartbeat renews the TTL every `LOCK_TTL_MS / 3`
- Why: slow but healthy work should not lose its lock. If renewal fails, a "lost lock" flag is set and the worker rolls back before commit when it can. This is a best-effort optimization. Correctness does not depend on it (D4).

### D15. The reaper reclaims with `XAUTOCLAIM` and caps deliveries at `MAX_DELIVERIES`
- Why: a worker that dies leaves its messages pending. The reaper gives them to a live worker after `VISIBILITY_TIMEOUT_MS`. A message that keeps crashing workers (poison) would loop forever, so the cap marks the event `dead` and acks the message.
- Detail: the delivery count comes from the pending entries list (`XPENDING`), and each claim increments it.

## D. Failures, retries, DLQ

### D16. Errors are `transient` or `permanent`. Unknown errors are transient
- Why: retrying a permanent error (like insufficient funds) wastes time and delays the DLQ. Treating an unknown error as permanent could drop a recoverable event. When unsure, retry, and the attempt cap protects us.

### D17. Exponential backoff with full jitter, tracked in a Redis ZSET
- Formula: `delay = random(0, min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(attempts-1)))`.
- Why jitter: without it, many failed events retry at the same moment and hit the same weak dependency together.
- Why a ZSET: score is the ready time, a Lua script moves due ids to the stream atomically.
- Order: `ZADD` first, then `XACK`. A crash between them gives a duplicate, never a lost retry.
- The `attempts` count lives in Postgres, not Redis, so a Redis wipe does not reset it. If the ZSET is lost, the sweeper recovers `retrying` events.

### D18. The DLQ is a status in Postgres (`events.status = 'dead'`), not a Redis structure
- Why: it survives a Redis wipe, is queryable and pageable, and replay is one conditional `UPDATE ... WHERE status='dead'`.
- Rejected: a separate Redis DLQ stream (second source of truth, lost on wipe).

### D19. Replay is a conditional update, so only one caller wins
- Why: `UPDATE ... WHERE status='dead' RETURNING` is atomic. Others get no row and a 409. Replay resets `attempts` to 0.
- Detail: if `XADD` fails after the update, the response is still 202. The event is `retrying` in Postgres, and the sweeper will enqueue it.
- I-RTY-8 has two valid scopes. Route-level CI tests the single-instant atomicity of the conditional update: one concurrent caller returns 202 and the rest return 409. In live operation, a still-failing replay can be processed and moved back to `dead` before later requests arrive, so repeated replay requests over time can each return 202. Both behaviors are correct; the ledger constraint still prevents duplicate business effects. Operators should fix the underlying cause before replaying.

### D20. The sweeper recovers from Postgres and uses an advisory lock
- Why: this is what makes "wipe Redis, lose nothing" true. It finds `received` and `retrying` events not updated for `SWEEP_STALE_MS`, bumps `updated_at`, and re-adds them to the stream.
- `pg_try_advisory_lock(7001)` means one sweeper runs at a time. `FOR UPDATE SKIP LOCKED` and the `updated_at` bump stop repeated sweeps.
- Runs inside the relay process (one fewer process to run). Duplicate messages from a sweep are safe.

## E. Data and API

### D21. Money is `bigint` minor units, INR only
- Why: floats cause rounding errors. Paise as integers are exact. One currency keeps the project focused on the real topic.

### D22. Raw SQL with `pg`, no ORM
- Why: the project is about transactions, locks, and constraints. We need to see and explain each statement. An ORM hides `FOR UPDATE`, `ON CONFLICT`, and `SKIP LOCKED`.
- All queries are parameterized.

### D23. The effect is a wallet ledger with one ledger row per event
- Why: it gives an effect that is easy to verify. A duplicate effect means a wrong balance, and `wallet == sum(ledger)` is a one-line check.
- `payout.requested` uses a conditional `UPDATE ... WHERE balance_minor >= amount` so funds are checked atomically. The `balance_minor >= 0` CHECK is the last net.

### D24. Static API key in the header, compared with `timingSafeEqual`
- Why: enough to keep the demo from being open. Not a user system (non-goal).

### D25. No ordering guarantee across events
- Why: ordering needs per-key partitioning, which needs a different design. A payout that arrives before its payment fails permanently and can be replayed. Documented as a limitation. Ordering is not part of what this project claims.

### D26. No rate limiting, no key expiry in v1
- Why: scope. Both are listed as future work in the README.

## F. Operations and testing

### D27. One Docker image, three entrypoints (api, relay, worker)
- Why: one build, one dependency set, simple CI. Compose picks the command. `docker compose up --scale worker=3` shows many workers.
- Do not publish worker metrics ports to the host in Compose (scaling would cause port clashes). Prometheus scrapes inside the network.
- Worker and relay metrics are network-internal and are not published to the host.

### D28. Chaos is built into the code behind flags, with a production guard
- Why: crash-after-commit and lock expiry cannot be tested from outside. Hooks make them repeatable.
- Rules: off by default, refuse to start with `NODE_ENV=production`, inert in unit tests, and `chaos.configure()` is allowed only when `NODE_ENV=test`.
- Two modes: lite (in-process, in CI) and full (real SIGKILL and Redis flush, local).

### D29. Invariant checks are the definition of correct
- Why: "it worked in my demo" is not proof. After every run, the same ten checks run (see `docs/TESTING.md`). Any failure is a bug in the code, never in the test.

### D30. k6 for load, and every number comes from the scripts
- Why: k6 has arrival-rate scenarios and a JSON summary. The report script builds `docs/RESULTS.md`. No number is written by hand, so every claim in the README can be defended.

### D31. Deploy: Docker Compose on one EC2 instance with Caddy for HTTPS (stretch)
- Why: it reuses the QuickPark deployment know-how and shows a real running system. It is first in the cut order (PRD section 12), so the project is complete without it.

## G. Gaps in the other docs, resolved here

The agent should use these defaults and not stop to ask. They are small and do not change any decision above.

| # | Gap | Resolution |
|---|---|---|
| G1 | `METRICS_PORT` is used in `ARCHITECTURE.md` section 12 but missing from the `.env.example` list | Add `METRICS_PORT` (worker default 9101, relay default 9102) to `.env.example` |
| G2 | Test database and Redis settings are not listed | Add `TEST_DATABASE_URL` and `TEST_REDIS_URL` (Redis DB 15) to `.env.example` |
| G3 | Stream group start id is not stated | Use `0` (see D10) |
| G4 | How "crash" works inside in-process tests is not defined | `chaos.configure({ crash })` seam, active only in `NODE_ENV=test` (see D28 and `docs/TESTING.md` section 6.1) |
| G5 | A successful run increments `attempts` too | Yes, as written in `processInTx`. So a first-try success has `attempts=1` |
| G6 | If the Redis lock is lost and the message was dropped | Sweeper covers it (see D13) |
| G7 | Reaper needs delivery counts, which `XAUTOCLAIM` does not return per message | Read them from `XPENDING` for the claimed ids (see D15) |
| G8 | Replay when `XADD` fails | Respond 202, sweeper recovers (see D19) |
| G9 | `.gitignore`, `README.md`, `docker-compose.yml`, `Dockerfile`, CI file, `LICENSE` are not in the layout list | Create them. `.gitignore` must include `.env`, `node_modules`, `dist`, `scripts/load/plan.json`, `coverage` |
| G10 | `docs/OPEN-QUESTIONS.md` is referenced but does not exist | Create it in Phase 0, empty with a short header |

## H. Honest limits (for the README and for interviews)

- Delivery is at-least-once. Duplicates are expected and handled. Nothing here claims otherwise.
- No global ordering across events.
- Single Postgres and single Redis, no failover.
- Redis Streams are not a replicated log. Postgres plus the sweeper is the recovery path.
- Idempotency keys are never deleted in v1.
- The side effect here is a database write, so it can join the transaction. A real external call (a bank API) cannot join it. That case needs the external system to accept an idempotency key too. State this when asked "what if the effect is not in your database".
- Numbers in `docs/RESULTS.md` are from one machine and are not a capacity claim.
