# BUILD PLAN

Build one phase at a time. Write tests before or with the code. At the end of each phase: run the exit criteria, paste real output, list deviations, then STOP and wait for approval (see the report format in `AGENTS.md`).

Time estimates are for a solo developer using a coding agent. They are guides, not promises.

| Phase | Name | Est. | Proves |
|---|---|---|---|
| 0 | Foundation | 0.5 day | Repo, tooling, DB, Redis, health |
| 1 | Ingest API and outbox | 1 day | F1, F2, F3, AC-1 (event side) |
| 2 | Relay | 0.5 day | F4 |
| 3 | Worker core | 1.5 days | F5, F7, F8 basics, FR-7, FR-8 |
| 4 | Retries, DLQ, replay | 1 day | F9, F10, F11, F15, AC-7 |
| 5 | Reliability loops, metrics, shutdown | 1 day | F6, F12, F13, F16 |
| 6 | Chaos harness and invariants | 1.5 days | AC-2 to AC-6 |
| 7 | Load test and report | 1 day | AC-8 |
| 8 | CI, Docker polish, README, deploy | 1 day | AC-9, AC-10 |

Total: about 9 days. If time runs short, use the cut order at the end of this file.

## Rules for every phase

- Read `AGENTS.md` hard rules before starting.
- Build in the repo root. One lockfile: `pnpm-lock.yaml`.
- Small commits in conventional style.
- Tests named with the IDs from `docs/TESTING.md`.
- Update docs only if behavior changed, and list that in the report.
- Do not start the next phase without approval.

---

## Phase 0: Foundation

Goal: an empty but correct skeleton that runs.

Tasks:

1. `git init`, `.gitignore` (see G9 in `docs/DECISIONS.md`), `.env.example` (all variables from `ARCHITECTURE.md` section 11 plus `METRICS_PORT`, `TEST_DATABASE_URL`, `TEST_REDIS_URL`), `docs/OPEN-QUESTIONS.md`.
2. `package.json` with all scripts from `AGENTS.md` (scripts for later phases can print "not implemented yet" and exit 1). Node 20, pnpm, `"type": "module"` or CommonJS (pick one, state it in the report).
3. `tsconfig.json` with `strict: true`. ESLint (typescript-eslint) and Prettier.
4. vitest config with separate unit, integration, and chaos projects. `globalSetup` for the test database.
5. `docker-compose.yml`: `postgres:16` and `redis:7` (with `--appendonly yes`), healthchecks, volumes. Services for `api`, `relay`, `worker` come in later phases.
6. `src/shared/`: `config.ts` (Zod-parsed env, chaos production guard), `db.ts` (`pg.Pool` max 20, `withTx(fn)`, error code mapping), `redis.ts` (ioredis client factory), `logger.ts` (pino), `hash.ts` (`stableStringify`, `payloadHash`), `chaos.ts` (inert stub with the hook names), `metrics.ts` (prom-client registry, all metric names from `ARCHITECTURE.md` section 12 registered).
7. `migrations/001_init.sql` exactly as in `docs/DATA-MODEL.md`. `scripts/migrate.ts` with the `schema_migrations` table, safe to run twice.
8. Minimal `src/api/server.ts` with `/health`, `/ready`, `/metrics`. `src/bin/api.ts`.

Tests: U-1, U-2, U-7, U-8 (config and chaos guard), U-9 (if the middleware exists yet), migration runs twice without error.

Exit criteria (all must pass):

```
pnpm install --frozen-lockfile
docker compose up -d postgres redis
pnpm migrate && pnpm migrate        # second run applies nothing
pnpm lint && pnpm typecheck
pnpm test:unit
pnpm dev:api &  curl -s localhost:3000/health
curl -s localhost:3000/ready
curl -s localhost:3000/metrics | head
CHAOS_ENABLED=true NODE_ENV=production pnpm dev:api   # must exit with an error
psql "$DATABASE_URL" -c '\d events' -c '\d ledger_entries'   # constraints present
```

---

## Phase 1: Ingest API and outbox

Goal: Flow A from `ARCHITECTURE.md` section 3, with auth and error handling.

Tasks:

1. `src/domain/schemas.ts`: Zod schemas (`.strict()` payloads) for both event types. `src/domain/errors.ts`: `PermanentError`, `TransientError`, API error classes.
2. Middleware: API key check (`timingSafeEqual`), request logging (no bodies), central error handler (error shape from `API.md`), `express.json({ limit: '10kb' })`.
3. `POST /v1/events` exactly as in Flow A. One transaction for event plus outbox on the new-key path. Return 202, 200 (duplicate), or 422.
4. `GET /v1/events/:id`.
5. Metrics: `events_received_total{result}`, `duplicates_blocked_total{layer="api"}`, `api_request_duration_seconds`.

Tests: U-3, U-4, U-9, U-10, I-API-1 to I-API-13.

Exit criteria:

```
pnpm test:unit && pnpm test:integration -- tests/integration/api
# manual:
curl -i -X POST localhost:3000/v1/events -H 'X-API-Key: change-me' -H 'Idempotency-Key: k1' \
  -H 'Content-Type: application/json' \
  -d '{"type":"payment.captured","payload":{"merchant_id":"m_1","amount_minor":50000,"currency":"INR","payment_id":"p1"}}'
# repeat the same call: 200 duplicate:true
# change the amount, same key: 422 IDEMPOTENCY_KEY_REUSED
psql -c "select count(*) from events; select count(*) from outbox;"    # 1 and 1
# 1000 parallel same key (test I-API-4) shows: one 202, 999 x 200, 1 event row
```

---

## Phase 2: Relay

Goal: Flow B. Outbox rows reach the stream.

Tasks:

1. `src/relay/relay.ts`: poll loop with `FOR UPDATE SKIP LOCKED`, `XADD events:stream * event_id <uuid> type <type>`, mark `published_at`, commit. `RELAY_BATCH` and `RELAY_POLL_MS` from config.
2. `src/bin/relay.ts` with graceful stop and a metrics port (`METRICS_PORT`, default 9102).
3. Test hook (chaos-guarded) to crash after `XADD` before `COMMIT`.
4. Add `relay` to `docker-compose.yml`, plus the single `Dockerfile` (multi-stage, one image for all three entrypoints, non-root user). Add `api` too.
5. Metric `stream_length`.

Tests: I-REL-1 to I-REL-4.

Exit criteria:

```
pnpm test:integration -- tests/integration/relay
docker compose up -d --build
# post 100 events, then:
redis-cli XLEN events:stream          # 100
psql -c "select count(*) from outbox where published_at is null"   # 0
docker compose up -d --scale relay=3  # still 100 messages for 100 events
```

---

## Phase 3: Worker core

Goal: Flow C and the effects. The heart of the project.

Tasks:

1. `src/worker/lock.ts`: `tryAcquire` (`SET NX PX`, random token), `release` (Lua compare-and-delete), `startHeartbeat` (Lua compare-and-pexpire every `LOCK_TTL_MS/3`, sets a lost-lock flag on failure).
2. `src/domain/effects.ts`: `applyEffect` for both types exactly as in `ARCHITECTURE.md` section 6.
3. `src/worker/handler.ts`: `handle(msg)` and `processInTx(id)` exactly as written in Flow C, including `SET LOCAL` timeouts, status check, and `xack_and_del` only after commit.
4. `src/worker/worker.ts`: create the group (`XGROUP CREATE ... 0 MKSTREAM`, ignore `BUSYGROUP`), `XREADGROUP` loop with `WORKER_CONCURRENCY`, consumer name `<hostname>-<pid>`.
5. Chaos hooks wired in handler: `failBeforeEffect`, `crashBeforeCommit`, `crashAfterCommit`, `pause`. Implement the module fully now (`docs/TESTING.md` section 6.1), including `chaos.configure` for `NODE_ENV=test`.
6. `src/bin/worker.ts`, add `worker` to Compose (no host port published).
7. `GET /v1/wallets/:merchantId` with `verify=true`.
8. Metrics: `events_processed_total`, `processing_duration_seconds`, `duplicates_blocked_total` for `lock`, `db_status`, `ledger_constraint`, `stream_pending`.

Tests: I-WRK-1 to I-WRK-11, U-8.

Exit criteria:

```
pnpm test:integration -- tests/integration/worker
docker compose up -d --build --scale worker=3
# post 200 events (50 percent duplicate requests), wait, then:
curl -s 'localhost:3000/v1/wallets/m_1?verify=true'          # verified:true
psql -c "select count(*) from ledger_entries; select count(*) from events where status='processed'"   # equal
# run the reconciliation query from DATA-MODEL.md in psql: it must return 0 rows
```

Failure retries are not in this phase yet: for now an error leaves the message pending (the reaper in Phase 5 reclaims it).

---

## Phase 4: Retries, DLQ, replay

Goal: `handleFailure`, backoff, delayed mover, DLQ, replay.

Tasks:

1. `src/worker/retry.ts`: backoff function (injectable RNG), `classify(err)`, `handleFailure` exactly as in Flow C (conditional `UPDATE ... AND status <> 'processed'`, `ZADD` before `XACK`, no ack if the database write fails).
2. `src/worker/delayed.ts`: the Lua mover (take due ids, `XADD`, `ZREM`, atomic) running every 500 ms in each worker.
3. `src/api/routes/admin.ts`: `GET /v1/dlq` (paging) and `POST /v1/dlq/:eventId/replay` (conditional update, then `XADD`).
4. Metrics: `events_failed_total{kind}`, `events_retried_total`, `events_dead_total{reason}`, `delayed_size`.

Tests: U-5, U-6, I-RTY-1 to I-RTY-9 (I-RTY-10 may wait for Phase 5 because it needs the sweeper).

Exit criteria:

```
pnpm test:unit && pnpm test:integration -- tests/integration/retry
# manual:
# 1. post a payout for a merchant with no funds: GET /v1/events/:id shows dead, attempts 1, INSUFFICIENT_FUNDS
# 2. GET /v1/dlq lists it
# 3. post a payment to fund the wallet, then POST /v1/dlq/:id/replay: 202
# 4. event becomes processed, ledger has 2 rows, wallet verified
# 5. 20 parallel replays on another dead event: one 202, nineteen 409
```

---

## Phase 5: Reliability loops, metrics, shutdown

Goal: crashed workers and a wiped Redis cannot lose events.

Tasks:

1. `src/worker/reaper.ts`: `XAUTOCLAIM` every 5 s, process claimed messages with `handle`, delivery cap with `XPENDING` counts, mark `dead` with `max deliveries exceeded`. Metric `messages_reclaimed_total`.
2. `src/relay/sweeper.ts`: advisory lock `7001`, stale query from `ARCHITECTURE.md` section 9, `XADD`. Metric `sweeper_requeued_total`. Start it inside the relay process.
3. Graceful shutdown for api, relay, worker (FR-17, `SHUTDOWN_GRACE_MS`, exit codes).
4. Complete the metric set from `ARCHITECTURE.md` section 12. Make sure all log lines about an event have `event_id`.
5. `/ready` checks both dependencies and names the failing one.

Tests: I-RPR-1, I-RPR-2, I-SWP-1 to I-SWP-5, I-RTY-10, I-SHD-1, I-SHD-2, I-MET-1, I-API-14.

Exit criteria:

```
pnpm test:integration
# manual:
docker compose up -d --build --scale worker=3
# post 500 events, then: docker kill -s KILL <one worker>
# all 500 reach processed or dead; ledger count equals processed count
redis-cli FLUSHALL        # during processing
# wait SWEEP_STALE_MS + SWEEP_INTERVAL_MS: all events reach a final state
docker stop <worker>      # exits 0 within the grace time
curl -s localhost:3000/metrics | grep -E 'messages_reclaimed|sweeper_requeued'
```

---

## Phase 6: Chaos harness and invariants

Goal: the project proves itself. This phase is required and is never cut.

Tasks:

1. `tests/helpers/`: `startStack`, `postEvent`, `waitForDrain`, `assertInvariants` (INV-1 to INV-10), `makeEvent`, seeded RNG with `CHAOS_SEED` (see `docs/TESTING.md`).
2. `tests/chaos/`: scenarios C-1 to C-9.
3. `scripts/chaos/`: full-mode runner for CF-1 to CF-6 using the Docker CLI, plus `pnpm test:chaos:full`.
4. Wire `pnpm test:chaos` and make sure it is stable: run it 5 times in a row locally with different seeds. No flaky results.
5. If a chaos test finds a bug, fix the code (never the invariant). Record the bug and the fix in the phase report. These stories are good interview material.

Exit criteria:

```
pnpm test:chaos                       # passes
for i in 1 2 3 4 5; do CHAOS_SEED=$i pnpm test:chaos || break; done   # five passes in a row
pnpm test:chaos:full                 # CF-1 to CF-6 all pass (local)
# every F1 to F16 row in docs/TESTING.md section 8 has a passing test
```

---

## Phase 7: Load test and report

Goal: real numbers and `docs/RESULTS.md`.

Tasks:

1. `scripts/load/run.ts` (plan generation, wallet seeding, metric snapshots, k6 run, drain, invariants), `scripts/load/k6-ingest.js` (`smoke`, `dup_heavy`, `same_key_storm`).
2. `scripts/report.ts`: builds `docs/RESULTS.md` using the table in `docs/TESTING.md` section 7.3. It reads k6 JSON, Prometheus snapshots, and DB queries. No hand-typed numbers.
3. `pnpm load` runs all of it. Record machine info and config in the report header.
4. Run it at least 3 times. Keep the last run in `docs/RESULTS.md` and say the others were similar or different, only if that is true.

Exit criteria:

```
pnpm load
cat docs/RESULTS.md      # has throughput, API p50/p95/p99, end-to-end p95, duplicates blocked by layer, invariants all PASS
# same_key_storm: 1 event, 1 ledger entry (AC-1)
```

---

## Phase 8: CI, Docker polish, README, deploy

Tasks:

1. `.github/workflows/ci.yml` as in `docs/TESTING.md` section 10 (services Postgres 16 and Redis 7, banned-phrase and long-dash grep step).
2. Compose polish: healthchecks, `depends_on` with `service_healthy`, a one-shot `migrate` service, `restart: unless-stopped`, `docker compose up --build` works from a clean clone in under 5 minutes (NFR-7). Test it in a fresh folder.
3. `README.md` (readable in 2 minutes): what it is, the guarantee sentence, architecture diagram (Mermaid from `ARCHITECTURE.md`), the failure matrix, quick start, how to run tests, chaos demo commands, numbers from `docs/RESULTS.md`, known limitations (`ARCHITECTURE.md` section 14 and `DECISIONS.md` section H). The banned phrase must not appear.
4. Final cleanup: no secrets, no stray lockfile (`package-lock.json` or `yarn.lock` must not exist), no TODOs left without an `OPEN-QUESTIONS.md` entry.
5. Stretch (first in cut order): EC2 deploy with Docker Compose and Caddy for HTTPS (domain, `Caddyfile` reverse proxy to `api:3000`, only ports 80 and 443 open, `/metrics` not exposed publicly, a non-default `API_KEY`, `CHAOS_ENABLED=false`). Run the manual smoke test from `docs/TESTING.md` section 10.

Exit criteria:

```
# in a fresh clone:
docker compose up --build            # stack healthy
# CI green on the main branch
grep -rniE "exactly.?once" src docs README.md tests scripts                 # no matches
grep -rn $'\xe2\x80\x94' src docs README.md tests scripts                  # no long dash
ls | grep -E 'package-lock|yarn.lock'    # nothing
# README checklist: guarantee, diagram, failure matrix, numbers from RESULTS.md, limitations
# (stretch) smoke test passes on the public URL
```

---

## Acceptance checklist (from `docs/PRD.md` section 9)

| AC | Phase it is proven in |
|---|---|
| 1. 1,000 parallel same-key requests give 1 event and 1 ledger entry | 1 (event), 3 (effect), 7 (load) |
| 2. 50 percent duplicate load passes invariants | 7 |
| 3. SIGKILL on workers loses nothing | 5, 6 |
| 4. Crash after commit before ack is skipped | 3, 6 |
| 5. Redis wipe loses nothing | 5, 6 |
| 6. Expired lock cannot cause a double effect | 6 |
| 7. Permanent failure goes dead with 1 attempt, replay works | 4 |
| 8. `docs/RESULTS.md` from real runs | 7 |
| 9. README readable in 2 minutes | 8 |
| 10. Deployed on EC2 (stretch) | 8 |

## Cut order if time runs short

Cut in this order (same as `docs/PRD.md` section 12):

1. EC2 and Caddy deployment (keep Docker Compose local).
2. Extra k6 scenarios (keep `dup_heavy`, and keep `same_key_storm` because it proves AC-1).
3. Metric histograms beyond the basics.
4. Graceful shutdown polish (keep the basic SIGTERM handling).

Never cut: the invariants, the chaos tests, the sweeper, the row-lock plus status-check transaction.

## What to say if something is blocked

Write it in `docs/OPEN-QUESTIONS.md` with: the question, the two docs that conflict (or what is missing), the options, and your recommended default. Then ask. Do not guess and do not change an invariant.
