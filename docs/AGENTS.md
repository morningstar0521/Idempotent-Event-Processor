# AGENTS.md

Project: **idempotent-event-processor**
Owner: Shubh Ghiya (solo build, portfolio and interview project for SDE roles)
Goal: a small but production-style backend that is easy to demo, easy to test, and easy to explain in an interview.

## The one idea (do not lose this)

- Postgres is the source of truth.
- Redis is only a delivery helper (stream, delayed retries, lock).
- The lock is for efficiency, not correctness.
- Correctness comes from database rules: unique idempotency key, row lock plus status check in one transaction, and a unique constraint on `ledger_entries.event_id`.

## Guarantee wording (use exactly this)

> At-least-once delivery with idempotent processing. Each unique idempotency key produces at most one business effect.

Never write "exactly-once" anywhere (code, comments, logs, README, docs, commit messages).

## Fixed stack (no additions without asking)

| Area | Choice |
|---|---|
| Language | TypeScript (strict), Node 20 |
| Package manager | pnpm (one lockfile only: `pnpm-lock.yaml`) |
| HTTP | Express 5 |
| Validation | Zod |
| Database | PostgreSQL 16 via `pg` (raw parameterized SQL, no ORM) |
| Queue and lock | Redis 7 via `ioredis` (Streams, ZSET, `SET NX PX`, Lua) |
| Logging | pino (JSON) |
| Metrics | prom-client |
| Tests | vitest |
| Load test | k6 |
| Container | Docker, Docker Compose |
| CI | GitHub Actions |
| Dev runner | tsx |

Not allowed: BullMQ, Kafka, RabbitMQ, any ORM, any LLM or AI call, any new database.

## Repo layout (build in the repo root, never in a nested folder)

```
src/
  api/          server.ts, routes/events.ts, routes/admin.ts, middleware/
  relay/        relay.ts (outbox to stream), sweeper.ts (recovery from Postgres)
  worker/       worker.ts, handler.ts, lock.ts, retry.ts, delayed.ts, reaper.ts
  domain/       effects.ts, schemas.ts, errors.ts
  shared/       config.ts, db.ts, redis.ts, logger.ts, metrics.ts, hash.ts, chaos.ts
  bin/          api.ts, relay.ts, worker.ts   (entrypoints)
migrations/     001_init.sql
scripts/        migrate.ts, report.ts, chaos/, load/k6-ingest.js
tests/          unit/, integration/, chaos/
docs/           PRD, ARCHITECTURE, DATA-MODEL, API, TESTING, DECISIONS, BUILD-PLAN, RESULTS (generated)
```

One Docker image, three entrypoints (api, relay, worker).

## Commands (must exist and work)

```
pnpm install
pnpm migrate
pnpm dev:api | pnpm dev:relay | pnpm dev:worker
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:chaos          # lite, in-process crash injection, runs in CI
pnpm test:chaos:full     # uses docker kill and Redis flush, local only
pnpm load                # runs k6 and writes docs/RESULTS.md
docker compose up --build
docker compose up --scale worker=3
```

## Hard rules

1. Follow the docs. If docs conflict or something is missing, write it in `docs/OPEN-QUESTIONS.md` and ask. Do not guess.
2. Never weaken or remove an invariant (see `docs/TESTING.md`) to make a test pass. Fix the code.
3. Money is stored as integer minor units (`bigint`). Never use floats for money.
4. All SQL is parameterized. No string concatenation into SQL.
5. Every error is classified as `transient` or `permanent` (see `docs/ARCHITECTURE.md`). Permanent errors never retry.
6. Never ack a Redis message until the database outcome is committed.
7. Never trust Redis for state that matters. If Redis is wiped, the sweeper must recover from Postgres.
8. Never hold the Redis lock without a TTL. Always release with compare-and-delete (Lua).
9. Chaos flags are off by default and must refuse to run when `NODE_ENV=production`.
10. Never invent benchmark or test numbers. Only report numbers the scripts produce.
11. No secrets in git. Use `.env.example`, keep `.env` ignored.
12. Keep functions small and named by what they do. Comments explain why, not what.
13. Small commits, conventional style (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
14. Do not use the long dash character in docs or code comments. Use "-" or ":".

## Definition of done (per phase)

- Code merged to main in small commits.
- Exit criteria in `docs/BUILD-PLAN.md` all pass, with real command output shown.
- `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` pass.
- Docs updated if behavior changed.
- Deviations from the docs listed in the phase report.

## Reporting format at the end of each phase

```
Phase N report
- Done: ...
- Exit criteria output: (paste real output)
- Deviations from docs: ...
- Open questions: ...
- Next phase ready: yes/no
```

Then stop and wait.
