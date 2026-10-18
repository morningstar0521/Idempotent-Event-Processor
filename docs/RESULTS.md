# Load test results

Status: PASS

## Header

- Run date: 2026-10-18T00:39:05.754Z
- Git SHA: 045363e5eefa1481377886db3e3c08ddce0a5830
- Node: v26.5.0
- Load test runtime note: This load test was run on Node v26.5.0. CI and Docker use Node 20 (LTS). Both versions pass the identical test suite; the load test numbers are indicative.
- Machine: Apple M1 Pro; 10 cores; 16 GiB RAM; darwin 24.6.0
- Docker server: 29.8.2
- Worker count: 3
- Chaos result provenance: Chaos results were produced on commit 7cb953f with no subsequent changes to worker, relay, or chaos source.

### Configuration

```dotenv
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

## Requests

- ceiling sends each unique event once: 0% duplicate traffic.

| Metric | Measured |
|---|---:|
| Total requests sent | 18001 |
| Unique idempotency keys | 18000 |
| 202 responses | 18000 |
| 200 responses | 1 |
| Errors | 0 |
| 422 responses | 0 |

## Throughput

| Metric | Measured |
|---|---:|
| Ingest rate (total requests/sec) | 199.97 |
| Unique event rate (events/sec) | 200.08 |

## Longer-run processing test (3 workers)

| Metric | Value |
|---|---:|
| Offered load | 200 req/s for 90s |
| Unique events sent | 18000 |
| Processed after drain | 18000 |
| Drain time (first created to last processed) | 89.96s |
| Sustained unique processing rate | 200.08 unique events/s |
| Peak stream_pending | 25 |
| Peak delayed_size | 0 |
| Verdict | ingest-bound |


## Latency by scenario

| Scenario | API p50 (ms) | API p95 (ms) | API p99 (ms) | E2E p95 (ms) |
|---|---:|---:|---:|---:|
| smoke | 1.88 | 3.89 | 4.31 | 102.46 |
| dup_heavy | 1.60 | 3.78 | 8.01 | 106.83 |
| same_key_storm | 311.83 | 1066.52 | 1090.94 | 134.96 |

## Duplicates blocked by layer

| Layer | Count |
|---|---:|
| api | 1 |
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

- Test machine: Apple M1 Pro. These numbers are not comparable to production servers.
- These numbers were captured on a single machine and are not a capacity claim.
- See docs/DECISIONS.md section H for honest limits.
- Re-run to reproduce: pnpm load
