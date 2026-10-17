# Load test results

Status: PASS

## Header

- Run date: 2026-10-17T23:03:35.199Z
- Git SHA: 3c704014180cc42e23847bb9f85d9e5de09c376b
- Node: v26.5.0
- Machine: Apple M1 Pro; 10 cores; 16 GiB RAM; darwin 24.6.0
- Docker server: 29.8.2
- Worker count: 3

### Configuration

```dotenv
NODE_ENV=development
PORT=3000
METRICS_PORT=9102
API_KEY=change-me
DATABASE_URL=postgres://postgres:postgres@localhost:5432/events
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/events_test
REDIS_URL=redis://localhost:6379
TEST_REDIS_URL=redis://localhost:6379/15

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

## Requests

| Metric | Measured |
|---|---:|
| Total requests sent | 1500 |
| Unique idempotency keys | 500 |
| 202 responses | 500 |
| 200 responses | 1000 |
| Errors | 0 |
| 422 responses | 0 |

## Throughput

| Metric | Measured |
|---|---:|
| Ingest rate (requests/sec) | 25.00 |
| Processed rate (events/sec) | 16.71 |

## Latency (dup_heavy)

| Source | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| API request duration | 5.58 | 9.29 | 12.70 |
| End-to-end | 59.49 | 107.44 | 114.11 |

## Duplicates blocked by layer

| Layer | Count |
|---|---:|
| api | 1000 |
| lock | 0 |
| db_status | 0 |
| ledger_constraint | 0 |

## Retries and dead

- events_retried_total: 0
- events_dead_total{reason="permanent"}: 0
- events_dead_total{reason="max_attempts"}: 0
- events_dead_total{reason="max_deliveries"}: 0

## Invariants

| Invariant | Status |
|---|---|
| INV-1 | PASS |
| INV-2 | PASS |
| INV-3 | PASS |
| INV-4 | PASS |
| INV-5 | PASS |
| INV-6 | PASS |
| INV-7 | PASS |
| INV-8 | PASS |
| INV-9 | PASS |
| INV-10 | PASS |

## Chaos full

```json
{
  "generated_at": "2026-10-17T22:15:58.481Z",
  "results": [
    {
      "id": "CF-1",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 46674,
      "invariants": true
    },
    {
      "id": "CF-2",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 2722,
      "invariants": true
    },
    {
      "id": "CF-3",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 3715,
      "invariants": true
    },
    {
      "id": "CF-4",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 3485,
      "invariants": true
    },
    {
      "id": "CF-5",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 2592,
      "invariants": true
    },
    {
      "id": "CF-6",
      "unique": 500,
      "processed": 500,
      "dead": 0,
      "lost": 0,
      "duplicateEffects": 0,
      "status": "PASS",
      "recovery_ms": 8652,
      "invariants": true
    }
  ]
}
```

## Notes

- These numbers were captured on a single machine and are not a capacity claim.
- See docs/DECISIONS.md section H for honest limits.
- Re-run to reproduce: pnpm load
