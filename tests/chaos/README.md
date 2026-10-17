# Chaos lite

Run against the test Postgres and Redis services:

```sh
pnpm test:chaos
CHAOS_SEED=123 pnpm test:chaos
pnpm test:chaos:full
```

Every run prints `CHAOS_SEED`. A failing seed is reproducible input, not a reason to retry until it turns green. A flaky chaos test is a bug in the code or the test and must be diagnosed.

The lite scenarios cover C-1 through C-9 and map to F6, F7, F8, F13, F12, F4, F9/F11, all rows, and F1/F6 respectively. Full scenarios CF-1 through CF-6 use Docker actions and write `scripts/chaos/results.json`.
