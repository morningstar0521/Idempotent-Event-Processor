# PRD: Idempotent Event Processor

## 1. Problem

In real systems, the same event often arrives more than once: a client retries after a timeout, a webhook is sent twice, a queue redelivers after a crash. If each copy runs its business effect, you get double payments, double emails, wrong balances.

This project accepts events and makes sure **each unique event changes the system at most once**, while never losing an event.

## 2. Guarantee

> At-least-once delivery with idempotent processing. Each unique idempotency key produces at most one business effect.

The guarantee wording above is the only delivery guarantee used in this project.

## 3. Use case (the business effect)

A simple payments wallet ledger:

- `payment.captured`: credits a merchant wallet.
- `payout.requested`: debits a merchant wallet. Fails permanently if funds are insufficient.

The effect is: one row in `ledger_entries` and one wallet balance change. This makes duplicates easy to detect: a double effect means a wrong balance.

Currency is INR only in v1 (amounts in paise, called `amount_minor`).

## 4. Users

| User | What they do |
|---|---|
| Producer service | Sends events with an `Idempotency-Key`. Retries freely. |
| Operator | Looks at event status, wallets, dead events. Replays dead events. |
| Interviewer / recruiter | Reads the README, runs `docker compose up`, watches the chaos test pass. |

## 5. Goals

1. Duplicate API requests do not create duplicate events.
2. Duplicate deliveries do not create duplicate effects.
3. A worker crash at any point does not lose an event or double-apply it.
4. A lock that expires while a worker is still running does not cause a double effect.
5. Wiping Redis does not lose events (recovered from Postgres).
6. Failed events retry with backoff, then go to a dead-letter queue (DLQ), and can be replayed safely.
7. The system can prove its own correctness with an automated chaos test and invariant checks.
8. Every claim in the README is backed by a measured number from this repo.

## 6. Non-goals (do not build)

- No user accounts, no UI, no frontend.
- No multi-currency, no real payment gateway.
- No strict ordering guarantee across events. (Known limitation, documented.)
- No Kafka, no Kubernetes, no multi-region.
- No idempotency key expiry or cleanup in v1. (Documented as future work.)
- No AI or LLM features.

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | `POST /v1/events` requires an `Idempotency-Key` header and a valid body. |
| FR-2 | A repeated key with the same body returns the original event (HTTP 200, `duplicate: true`). A new key returns HTTP 202. |
| FR-3 | A repeated key with a different body returns HTTP 422 `IDEMPOTENCY_KEY_REUSED` and changes nothing. |
| FR-4 | Many parallel requests with the same key create exactly one event row. |
| FR-5 | The event row and an outbox row are written in one database transaction. |
| FR-6 | A relay moves outbox rows to a Redis Stream. Multiple relays can run safely. |
| FR-7 | Workers read from the stream with a consumer group, and process each event in one database transaction that includes a row lock and a status check. |
| FR-8 | Processing an already processed event is a no-op, then ack. |
| FR-9 | Transient errors retry with exponential backoff and full jitter, up to `MAX_ATTEMPTS`. |
| FR-10 | Permanent errors go straight to `dead` with no retry. |
| FR-11 | Events that exceed `MAX_ATTEMPTS`, or `MAX_DELIVERIES` stream deliveries, become `dead`. |
| FR-12 | A reaper reclaims messages from crashed workers after the visibility timeout. |
| FR-13 | A sweeper re-enqueues stale `received` or `retrying` events from Postgres (Redis loss recovery). |
| FR-14 | `GET /v1/events/:id`, `GET /v1/wallets/:merchantId`, `GET /v1/dlq`, `POST /v1/dlq/:eventId/replay`. |
| FR-15 | Replay is safe to call many times (only one replay wins). |
| FR-16 | `/health`, `/ready`, `/metrics` endpoints. |
| FR-17 | Graceful shutdown: finish in-flight work, release locks, close connections. |
| FR-18 | Chaos flags to inject failures and crashes (off by default). |

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Correctness over speed. Never trade an invariant for throughput. |
| NFR-2 | All services are stateless. State lives in Postgres and Redis. |
| NFR-3 | Redis runs with AOF on in Docker, but correctness must not depend on it. |
| NFR-4 | Structured JSON logs with `event_id` on every line about an event. |
| NFR-5 | One command runs everything: `docker compose up --build`. |
| NFR-6 | CI runs lint, typecheck, unit, integration, and lite chaos tests. |
| NFR-7 | Setup from clone to running in under 5 minutes. |

## 9. Acceptance criteria (the project is done when all are true)

1. 1,000 parallel requests with the same key create 1 event and 1 ledger entry.
2. A 50 percent duplicate load run ends with the invariants in `docs/TESTING.md` all passing.
3. Killing workers with SIGKILL during a run loses no events and creates no double effects.
4. Crash after commit but before ack leads to a redelivery that is skipped.
5. Wiping Redis during a run loses no events (sweeper recovers them).
6. A paused worker whose lock expired cannot cause a double effect.
7. Permanent failures go to `dead` with 1 attempt. Replay after fixing the cause succeeds.
8. `docs/RESULTS.md` is generated from real runs and contains throughput, latency, and duplicates blocked.
9. README explains the design in under 2 minutes of reading, with an architecture diagram and the failure matrix.
10. Deployed on a single EC2 box with Docker Compose and Caddy HTTPS (stretch goal, see cut order).

## 10. Success metrics (measured, never invented)

| Metric | How measured |
|---|---|
| Duplicate effects | Must be 0 in every test and load run |
| Lost events | Must be 0 (all events end `processed` or `dead`) |
| Sustained throughput (events/s) | k6 + report script |
| API latency p50/p95/p99 | k6 |
| End-to-end latency (received to processed) p95 | report script from DB timestamps |
| Duplicates blocked, by layer (api, lock, db_status, ledger_constraint) | Prometheus counters |
| Time to recover after Redis wipe | chaos full run |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Scope grows (Kafka, UI, etc.) | Fixed stack in the architecture document, non-goals above |
| Happy-path-only implementation | Chaos harness is a required phase, not optional |
| Claims in README not backed | CI checks the project rules, and RESULTS.md is generated by script |
| Time runs out | Cut order below |

## 12. Cut order if time runs short

Cut in this order, first item first:
1. EC2 + Caddy deployment (keep Docker Compose local).
2. Extra k6 scenarios (keep one duplicate-heavy scenario).
3. `/metrics` histograms beyond the basics.
4. Graceful shutdown polish.

Never cut: invariants, the chaos test, the sweeper, the row-lock plus status-check transaction.
