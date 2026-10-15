# API

Base path: `/v1`. JSON only. All `/v1` routes require `X-API-Key: <API_KEY>` (compare with `crypto.timingSafeEqual`). `/health`, `/ready`, `/metrics` need no key.

Error shape for every error:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "human readable text", "details": [] } }
```

## Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body fails Zod schema |
| 400 | `MISSING_IDEMPOTENCY_KEY` | Header missing, empty, or longer than 255 chars |
| 401 | `UNAUTHORIZED` | Missing or wrong API key |
| 404 | `NOT_FOUND` | Unknown event or wallet |
| 409 | `NOT_REPLAYABLE` | Replay on an event that is not `dead` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| 503 | `UNAVAILABLE` | Postgres unreachable |

## POST /v1/events

Headers: `Idempotency-Key: <string 1..255>`, `X-API-Key`, `Content-Type: application/json`.

Body:

```json
{
  "type": "payment.captured",
  "payload": {
    "merchant_id": "m_123",
    "amount_minor": 50000,
    "currency": "INR",
    "payment_id": "pay_abc"
  }
}
```

`payout.requested` has `payout_id` instead of `payment_id`. `amount_minor` is a positive integer up to 1e12. `currency` must be `"INR"`. `merchant_id` is 1 to 64 chars `[A-Za-z0-9_-]`.

Responses:

| Case | Status | Body |
|---|---|---|
| New key | 202 | `{"event_id":"<uuid>","status":"received","duplicate":false}` |
| Same key, same body | 200 | `{"event_id":"<uuid>","status":"<current status>","duplicate":true}` |
| Same key, different body | 422 | error `IDEMPOTENCY_KEY_REUSED` |

Server-side steps are in `docs/ARCHITECTURE.md` Flow A. Hash input: `sha256` of a stable (sorted keys) JSON string of `{type, payload}`.

## GET /v1/events/:id

200:

```json
{
  "event_id": "uuid",
  "idempotency_key": "string",
  "type": "payment.captured",
  "status": "processed",
  "attempts": 1,
  "last_error": null,
  "last_error_kind": null,
  "created_at": "ISO",
  "processed_at": "ISO"
}
```

404 if unknown. Do not return `payload` (keeps responses small and avoids leaking data).

## GET /v1/wallets/:merchantId

Query: `verify=true` (optional).

200:

```json
{
  "merchant_id": "m_123",
  "balance_minor": 50000,
  "ledger_entries": 1,
  "verified": true,
  "ledger_sum_minor": 50000
}
```

`verified` and `ledger_sum_minor` appear only with `verify=true`. `verified` is `balance_minor === ledger_sum_minor`. 404 if the wallet does not exist.

## GET /v1/dlq

Query: `limit` (default 50, max 200), `before` (ISO timestamp, optional, for paging).

200:

```json
{
  "items": [
    {
      "event_id": "uuid",
      "type": "payout.requested",
      "attempts": 1,
      "last_error": "INSUFFICIENT_FUNDS",
      "last_error_kind": "permanent",
      "updated_at": "ISO"
    }
  ],
  "next_before": "ISO or null"
}
```

Source: `events WHERE status = 'dead'`, newest first. There is no separate Redis DLQ.

## POST /v1/dlq/:eventId/replay

Runs the replay query from `docs/DATA-MODEL.md`. If a row is returned, `XADD` to `events:stream`, then respond:

```json
{ "event_id": "uuid", "status": "retrying" }
```

Status 202. If not `dead` (or unknown), 409 `NOT_REPLAYABLE`. Safe to call repeatedly: only one call wins.

## GET /health

Always 200 `{"status":"ok"}` if the process is up.

## GET /ready

200 `{"status":"ready"}` if `SELECT 1` on Postgres and `PING` on Redis both succeed. Otherwise 503 with which dependency failed.

## GET /metrics

Prometheus text format. Metrics are listed in `docs/ARCHITECTURE.md` section 12.

## Request logging

One log line per request: method, route, status, duration, `event_id` if known. No bodies.

## Notes for the agent

- Use Express 5 async handlers and one central error middleware that maps domain errors to the table above.
- Validate with Zod. Reject unknown fields in `payload` (use `.strict()`).
- Set `express.json({ limit: '10kb' })`.
- Do not add rate limiting in v1.
