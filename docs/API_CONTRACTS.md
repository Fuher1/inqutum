# API Contracts

Integration-facing HTTP contract for the Quittance/Inqutum backend.

- **Contract version:** `1.0.0` (tracked in `CONTRACT_VERSION`, `backend/src/api/contract.ts`)
- **Enforced by:** `backend/tests/api-contract.test.ts`, which runs in CI
- **Base path:** `/api`

Every server response — success or failure — uses the envelope defined in
`backend/src/types/api.ts`. Both `server-mvp.ts` (in-memory) and `server.ts`
(Postgres) return the same shapes, so an integration written against one works
against the other; only the storage adapter differs.

## Why this document is checked

Prose goes stale silently. The route table below is generated from the
`API_CONTRACT` array, and `tests/api-contract.test.ts` fails the build when:

- a route is mounted that the contract does not declare,
- the contract declares a route that is not mounted on the surface it claims,
- the success or failure envelope changes shape,
- a handler emits an error code that is missing from `DOMAIN_ERROR_TAXONOMY`,
- a documented status is no longer the status the server returns,
- an unauthenticated call to the admin surface is accepted, or
- a route in the contract is missing from this document.

Route discovery is done by introspecting the live Express app, not by reading
this file, so adding a route without updating the contract fails even if nobody
re-reads the documentation.

## Envelopes

### Success

```json
{
  "success": true,
  "data": { "id": "0f1c…", "status": "PENDING", "memo": "INV-1042" },
  "message": "Invoice created",
  "pagination": { "limit": 50, "offset": 0, "total": 128, "nextCursor": null, "hasMore": false },
  "correlationId": "3f8c1a20-…"
}
```

`data` is always present. `message`, `pagination`, `correlationId` and
`apiVersion` are added when the endpoint has something to say.

### Endpoints that are not enveloped

Six endpoints return a raw body on success, because their consumer is not a
JSON client. They are marked in `API_CONTRACT` with `responseKind: 'raw'` and
the drift test pins that list, so it cannot grow by accident:

| Endpoint | Body | Read by |
| --- | --- | --- |
| `GET /` | JSON banner | humans / uptime scripts |
| `GET /api/health` | JSON probe payload | Kubernetes liveness |
| `GET /api/ready` | JSON probe payload | Kubernetes readiness |
| `GET /api/metrics` | Prometheus text | scraper |
| `GET /api/audit/export` | streamed document | browser download |
| `GET /api/exports/:id` | artifact body | browser download |

Do not wrap these in the envelope: it would break the platform tooling that
reads them. Everything else on the API returns the envelope.

### Failure

```json
{
  "success": false,
  "error": "Asset code is required for credit assets",
  "code": "INVALID_ASSET",
  "category": "VALIDATION",
  "retryable": false,
  "recoveryAction": "Supply both assetCode and assetIssuer, or omit both to use native XLM.",
  "correlationId": "3f8c1a20-…",
  "timestamp": "2026-09-27T09:14:02.118Z"
}
```

`error` is always a human-readable string. When the failure maps to a domain
error, `code`, `category`, `retryable` and `recoveryAction` come from
`DOMAIN_ERROR_TAXONOMY` in `backend/src/errors/error-taxonomy.ts` and are
guaranteed to agree with that table. Every failure carries a `correlationId`,
which is also logged — quote it in a bug report.

## Authentication

| Mode | Requirement |
| --- | --- |
| `none` | No credential. The invoice API is scoped by wallet key, not by login. |
| `admin` | `Authorization: Bearer <JOBS_ADMIN_TOKEN>`. Compared with `timingSafeEqual`. Absent token → 401, disabled route → 403. |
| `hmac` | Signed request body plus a timestamp header, verified against `WEBHOOK_SIGNING_SECRET` with a 5-minute tolerance and a replay window. Missing headers → 400 `MALFORMED_WEBHOOK`; stale timestamp → 408 `STALE_TIMESTAMP`; bad signature → 401 `INVALID_SIGNATURE`; replayed event id → 409 `DUPLICATE_EVENT`. |

> **Known gap.** The public invoice surface authenticates by wallet key rather
> than by a session, and the `/api/email/*` routes have no auth middleware. Both
> are recorded here as contract facts rather than hidden; they need a decision
> from the maintainers before this surface is exposed beyond a trusted network.
> Anything that mutates state (`verify`, `cancel`, `simulate-payment`) is
> reachable by anyone who can reach the server, so the Postgres deployment
> should sit behind an authenticating proxy until that changes.

## Pagination

List endpoints accept `limit` and `offset`, and prefer keyset pagination via
`after` (see `docs/PAGINATION.md`). `offset` is retained for older clients and
is unstable while invoices are being inserted.

The response carries a `pagination` block:

```json
{ "limit": 50, "offset": 0, "total": 128, "nextCursor": "2026-09-27T09:00:00.000Z|0f1c…", "hasMore": true }
```

`nextCursor` is `null` on the last page. `total` is the count of records
matching the filter, not the page size.

## Endpoints

### Public client surface

| Method | Path | Auth | Statuses | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/` | none | 200 | Server banner: name, version and storage mode. |
| `GET` | `/api/health` | none | 200 | Liveness plus the storage mode the server is running in. |
| `GET` | `/api/ready` | none | 200, 503 | Readiness probe. 503 when a dependency is unavailable. |
| `POST` | `/api/invoices` | none | 201, 400 | Create an invoice. 201 returns the stored invoice. |
| `GET` | `/api/invoices` | none | 200, 400, 500 | List invoices for a seller. Keyset pagination via `after`. |
| `GET` | `/api/invoices/stats` | none | 200, 400, 500 | Aggregated counts and revenue per asset for a seller. |
| `GET` | `/api/invoices/:id` | none | 200, 404, 500 | Fetch one invoice by id. |
| `GET` | `/api/invoices/:id/payment-info` | none | 200, 404, 500 | Payment details needed to settle an invoice (asset, memo, destination). |
| `GET` | `/api/invoices/:id/email-preview` | none | 200, 404, 500 | Rendered invoice email, as HTML and text, without sending. |
| `POST` | `/api/invoices/:id/cancel` | none | 200, 400, 404, 409 | Cancel a PENDING invoice. 409 once it is settled. |
| `POST` | `/api/invoices/:id/verify` | none | 200, 400, 404, 500 | Verify a submitted payment and settle the invoice. |
| `POST` | `/api/invoices/:id/simulate-payment` | none | 200, 404, 500 | Mark an invoice paid without contacting the network (sandbox only). |
| `POST` | `/api/invoices/:id/send-email` | none | 200, 404, 500 | Email an invoice to its customer. |
| `GET` | `/api/invoices/:id/audit-trail` | none | 200, 404, 500 | Activity timeline for a single invoice. |
| `GET` | `/api/audit/events` | none | 200, 500 | Query audit events across invoices, filtered by type and time. |
| `GET` | `/api/audit/export` | none | 200, 500 | Stream a full audit export as a downloadable document. |
| `GET` | `/api/metrics` | none | 200 | Prometheus exposition format. |
| `GET` | `/api/observability/metrics` | none | 200 | JSON metrics: counters, latencies and error rates. |
| `GET` | `/api/notifications` | none | 200, 400 | Notifications for a recipient wallet, paginated. |
| `GET` | `/api/notifications/unread-count` | none | 200 | Unread notification count for a recipient wallet. |
| `POST` | `/api/notifications/:id/read` | none | 200, 404 | Mark one notification read. |
| `POST` | `/api/notifications/read-all` | none | 200 | Mark every notification for a recipient read. |
| `GET` | `/api/notifications/preferences` | none | 200, 400 | Retrieve durable notification routing preferences for a recipient. |
| `PUT` | `/api/notifications/preferences` | none | 200, 400 | Update durable notification routing preferences for a recipient. |
| `GET` | `/api/notifications/routing-audit` | none | 200, 400 | Retrieve routing and override audit trail for a recipient. |
| `POST` | `/api/exports` | none | 201, 400, 403, 500 | Generate an export artifact. Returns an expiring download handle. |
| `GET` | `/api/exports/:id` | none | 200, 400, 404, 410 | Download an export artifact. 410 once it has expired. |
| `GET` | `/api/stellar/account` | none | 200 | Account balances from Horizon. |
| `GET` | `/api/stellar/payments` | none | 200 | Recent payments for an account from Horizon. |
| `GET` | `/api/stellar/transaction/:hash` | none | 200, 404 | Fetch one transaction by hash. |
| `POST` | `/api/stellar/verify-payment` | none | 200, 400 | Verify a transaction hash against an expected asset and amount. |

### Admin / maintainer surface

| Method | Path | Auth | Statuses | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/payment/sync` | none | 200, 500 | Run a manual payment-monitor sync sweep. |
| `POST` | `/api/email/send` | none | 200, 400, 429, 502 | Send an email through the configured provider. |
| `GET` | `/api/email/deliveries` | none | 200 | Recent delivery attempts with provider status. |
| `GET` | `/api/email/problems` | none | 200 | Bounced and complained deliveries that need follow-up. |
| `POST` | `/api/email/webhook` | none | 200, 400, 404 | Provider delivery callback (bounce / complaint / delivered). |
| `GET` | `/api/jobs` | `admin` | 200, 400, 401, 403 | List background jobs with status counts. |
| `GET` | `/api/jobs/:id` | `admin` | 200, 401, 403, 404 | Inspect one job, including its full retry history. |
| `POST` | `/api/jobs/:id/retry` | `admin` | 200, 401, 403, 404, 409 | Requeue a dead-lettered job. 409 if it is not dead. |
| `GET` | `/api/ops/health` | `admin` | 200, 401, 403 | Operational health report for maintainers. |
| `GET` | `/api/ops/impersonation` | `admin` | 200, 401, 403 | List active support impersonation sessions. |
| `POST` | `/api/ops/impersonation` | `admin` | 201, 400, 401, 403 | Open a support impersonation session. Fully audited. |
| `POST` | `/api/ops/impersonation/end` | `admin` | 200, 401, 403, 404 | Close a support impersonation session. |
| `POST` | `/api/ops/policy/simulate` | `admin` | 200, 400, 401, 403 | Simulate policy changes against current dataset before committing. |
| `GET` | `/api/ops/stale-projections/detect` | `admin` | 200, 401, 403 | Detect projection drift, stale statuses, and orphaned records. |
| `POST` | `/api/ops/stale-projections/repair` | `admin` | 200, 401, 403 | Automate repair recommendations for detected projection drift. |
| `POST` | `/api/ops/synthetic-journey/run` | `admin` | 200, 401, 403, 503 | Run synthetic journey monitor across critical workflow with latency and dependency blame. |
| `POST` | `/api/ops/snapshot-restore/verify` | `admin` | 200, 401, 403, 422 | Verify snapshot restore package against data invariants and rebuild derived indexes. |
| `POST` | `/api/webhooks/incoming` | `hmac` (conditional) | 200, 400, 401, 408, 409 | Signed inbound webhook receiver. Rejects unsigned, stale and replayed events. |

`/api/webhooks/incoming` is mounted only when `WEBHOOK_SIGNING_SECRET` is set.

## Integration flows

### 1. Issue an invoice and settle it

```bash
# Create
curl -sX POST localhost:3001/api/invoices \
  -H 'content-type: application/json' \
  -d '{"sellerPublicKey":"GA5Z…","amount":"25.0000000","assetCode":"XLM","memo":"INV-1042"}'
# → 201 {"success":true,"data":{"id":"0f1c…","status":"PENDING",…}}

# Read the settlement instructions
curl -s localhost:3001/api/invoices/0f1c…/payment-info
# → 200 {"success":true,"data":{"amount":"25.0000000","assetCode":"XLM","memo":"INV-1042",…}}

# After the payer submits the payment, verify with the 64-char tx hash
curl -sX POST localhost:3001/api/invoices/0f1c…/verify \
  -H 'content-type: application/json' \
  -d '{"txHash":"'$(printf 'a%.0s' {1..64})'","payerPublicKey":"GBR…"}'
# → 200 {"success":true,"data":{"status":"PAID","paidAt":"2026-09-27T09:15:44.902Z",…}}
```

### 2. Handle a validation failure

```bash
curl -sX POST localhost:3001/api/invoices \
  -H 'content-type: application/json' \
  -d '{"sellerPublicKey":"GA5Z…","amount":"25.0000000","assetCode":"USDC"}'
```
```json
{
  "success": false,
  "error": "Credit assets require both assetCode and assetIssuer",
  "code": "ASSET_ISSUER_REQUIRED",
  "category": "VALIDATION",
  "retryable": false,
  "recoveryAction": "Add the asset issuer, or drop assetCode to use native XLM.",
  "correlationId": "3f8c1a20-…",
  "timestamp": "2026-09-27T09:14:02.118Z"
}
```

Branch on `code`, not on the `error` string — messages are for people and may
be reworded. Use `retryable` to decide whether to back off and retry, and
`recoveryAction` to tell the user what to change.

### 3. Inspect the background job queue

```bash
curl -s localhost:3001/api/jobs?status=dead -H 'authorization: Bearer '"$JOBS_ADMIN_TOKEN"
# → 200 {"success":true,"data":{"jobs":[…]},"pagination":{…}}

curl -sX POST localhost:3001/api/jobs/<id>/retry -H 'authorization: Bearer '"$JOBS_ADMIN_TOKEN"
# → 200 {"success":true,"data":{"status":"queued","attempts":0,…}}
```

See `docs/JOBS.md` for the lifecycle and `docs/RUNBOOK.md` for what to do with
a dead-lettered job.

## Changing the contract

1. Add or update the entry in `API_CONTRACT` (`backend/src/api/contract.ts`),
   including every status the handler can return.
2. Update the table in this document.
3. Run `npm test` in `backend/`. The drift test fails until both agree.
4. If a change is **breaking** (a removed field, a changed status, a new
   required auth), bump `CONTRACT_VERSION` and note it in the PR.

Related: [PAGINATION.md](PAGINATION.md), [SCHEMA_VERSIONING.md](SCHEMA_VERSIONING.md),
[RUNBOOK.md](RUNBOOK.md), [JOBS.md](JOBS.md)
