# Kickoff Prompt

Paste everything below the line into your coding agent (Codex, Claude Code, OpenCode). Put the other files in the repo first:

```
idempotent-event-processor/
  AGENTS.md
  docs/PRD.md
  docs/ARCHITECTURE.md
  docs/DATA-MODEL.md
  docs/API.md
  docs/TESTING.md
  docs/DECISIONS.md
  docs/BUILD-PLAN.md
```

Do NOT put `FOR-SHUBH-INTERVIEW-GUIDE.md` in the repo. It is for the human only.

Tip from your last build: create the repo folder yourself and run `git init` first. Tell the agent to build in the repo root, not in a nested folder, and to use one lockfile (pnpm-lock.yaml only).

---

You are building **idempotent-event-processor**: a backend system that accepts events (like payments) and guarantees that each unique event causes its business effect **at most once**, even with duplicate requests, duplicate deliveries, worker crashes, lock expiry, and Redis data loss.

## Read first, in this order

1. `AGENTS.md` (rules you must follow at all times)
2. `docs/PRD.md` (what and why)
3. `docs/ARCHITECTURE.md` (how it works, failure matrix)
4. `docs/DATA-MODEL.md` (exact SQL schema)
5. `docs/API.md` (exact endpoints and responses)
6. `docs/TESTING.md` (invariants, chaos scenarios, load test)
7. `docs/DECISIONS.md` (why each choice was made, do not reverse them)
8. `docs/BUILD-PLAN.md` (phases and exit criteria)

## The one idea you must not lose

Postgres is the source of truth. Redis only helps with delivery and speed. The Redis lock is for efficiency, NOT for correctness. Correctness comes from: a unique constraint on the idempotency key, a row lock on the event (`SELECT ... FOR UPDATE`), a status check inside the transaction, and a unique constraint on `ledger_entries.event_id`. If Redis is wiped, nothing is lost and nothing is applied twice.

## How to work

- Build ONE phase at a time from `docs/BUILD-PLAN.md`, starting with Phase 0.
- Write the tests for a phase before or together with the code.
- At the end of each phase: run the exit criteria commands, paste the real output, list any deviation from the docs, then STOP and wait for my go-ahead.
- If two docs conflict, or something is missing, do not guess. Add it to `docs/OPEN-QUESTIONS.md` and ask me.
- Never use the prohibited guarantee wording in code, comments, README, or docs. Use: "at-least-once delivery with idempotent processing".
- Never invent benchmark numbers. Only report numbers produced by the scripts in this repo.
- Do not add new infrastructure or libraries outside the stack in `AGENTS.md` without asking.

Start now with Phase 0. Confirm you read all docs by summarizing, in 10 lines or less, the guarantee, the processing transaction, and the three layers of duplicate protection. Then begin Phase 0.
