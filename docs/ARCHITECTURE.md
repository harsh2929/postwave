# Moosewave architecture

A working map of how the system is shaped, what owns what, and where
the boundaries are. This is the document to read before opening code.

## Bird's-eye view

```
                       ┌─────────────┐
                       │  Web admin  │  Next.js 15, React 19
                       │ apps/web    │
                       └──────┬──────┘
                              │  HTTPS + bearer token
                              ▼
┌──────────────┐       ┌────────────────────┐       ┌──────────────┐
│ Mobile (RN)  │──────▶│   API gateway      │◀──────│ SDKs / CLI / │
│ apps/mobile  │       │   apps/api         │       │ MCP server   │
└──────────────┘       │   (chi, pgxpool)   │       └──────────────┘
                       └────┬───────────────┘
                            │  internal HTTP (token-auth)
        ┌───────────────────┼────────────────────────────┐
        ▼                   ▼                ▼           ▼
┌────────────┐   ┌──────────────┐   ┌─────────────┐  ┌────────────┐
│  Voice     │   │  Migration   │   │ Automation  │  │ Deliver-   │
│  (Pillar 3)│   │  (importers) │   │ (asynq)     │  │ ability    │
│ services/  │   │ services/    │   │ services/   │  │ services/  │
│ voice      │   │ migration    │   │ automation  │  │ deliver…   │
└────────────┘   └──────────────┘   └─────────────┘  └────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Postgres    │ multi-tenant; FORCE RLS everywhere
                     │  (+ Redis    │
                     │   for asynq) │
                     └──────────────┘
                            ▲
                            │  HTTP only (per LICENSE-BOUNDARY.md)
                            │
                     ┌──────────────┐
                     │  Listmonk    │ pinned upstream AGPL image; separate
                     │  (subs, ESP, │ container; never imported as a
                     │   campaigns) │ Go package by Moosewave services.
                     └──────────────┘
```

## Tenancy

Every business table carries a `tenant_id uuid` column with **FORCE
ROW LEVEL SECURITY** enforced. Application code never gets to skip RLS
— writes that fail to bind `app.tenant_id` raise `WITH CHECK` violations
at insert time.

The binding pattern is:

```go
tx, _ := db.WithTenant(ctx, pool, tenantID) // SET app.tenant_id INSIDE tx
defer tx.Rollback(ctx)
// every query in this tx is RLS-scoped to tenantID
```

A handful of cross-tenant readers (the outbox worker, the campaign
scheduler) bind `app.outbox_worker = 'true'` instead, which trips a
permissive policy that allows platform-wide SELECTs but blocks UPDATEs.
Worker code re-binds `app.tenant_id` per-row before any write.

## API gateway: `apps/api`

The single entry point for everything user-facing. Terminates TLS,
validates API keys, applies idempotency for unsafe methods, and either
serves the request locally or proxies to a sibling service.

Internal layout:

| Package | Responsibility |
|---|---|
| `apikeys/` | Long-lived bearer tokens. Hashed-at-rest with HMAC pepper. Rotate is atomic two-row (revoke + create). |
| `subscribers/` | Tenant subscriber mirror. Every Upsert/Update fires webhook events inside the same tx. |
| `customfields/` | Tenant schema for `subscribers.custom_fields jsonb`. Validator with strict/auto/off modes. |
| `campaigns/` | Compose, schedule, send. The `Scheduler` worker polls `scheduled_at <= now()` and dispatches via Listmonk. |
| `forms/` | Hosted opt-in forms with double-opt-in via the transactional outbox. |
| `webhooks/` | Outbound tenant-webhook subscriptions + dispatcher + outbox-backed delivery with HMAC-SHA256 signing. |
| `outbox/` | Transactional outbox: callers Append in their write tx; a worker drains and dispatches by `kind`. |
| `analytics/` | Per-campaign reports + tenant dashboard rollups; reads `campaign_report_events` directly. |
| `listmonk_events/` | Inbound Listmonk webhook handler. Maps bounces/complaints to suppression rows + fires subscriber.bounced. |
| `sending/` | Postmark provisioning + warmup tier tracking. The send orchestrator gates on warmup cap. |
| `privacy/` | GDPR data-subject export + erasure. Builds tenant-scoped ZIP at request time. |
| `audit/` (in `handlers/audit.go`) | Audit log read endpoint over `audit_log` rows. |
| `migrationrunner/` | Bootstraps the database from `infra/migrations/*.sql` on startup. pg_advisory_lock + sha256 checksums. |

## The transactional outbox

Lives in `apps/api/internal/outbox`. Single Postgres table
`outbox_events(id, tenant_id, kind, payload jsonb, available_at,
claimed_by, claimed_until, attempts, max_attempts, ...)`.

Pattern: callers Append a row inside the same pgx tx that mutates
business state. A worker claims rows via `SELECT FOR UPDATE SKIP LOCKED`
with a per-row lease, runs the registered handler for the row's `kind`,
and either marks completed or bounces with backoff up to `max_attempts`
then DLQs.

Registered kinds today:

- `forms.confirm.enable_listmonk` — DOI confirmed → flip Listmonk subscriber to enabled
- `webhooks.deliver` — one per matched tenant subscription per fired event
- `webhook.fanout` — sibling-service-emitted events; expanded into N `webhooks.deliver` rows by FanoutHandler

This is how subscriber writes from `apps/api` AND terminal events from
`services/migration|automation|voice` all converge on one signing +
retry + DLQ pipeline.

## Sibling services

Each lives in `services/<name>/` as a separate Go module (registered in
`go.work`). They speak only over HTTP via internal-token auth and never
import `apps/api/internal/*`. Cross-service events flow through the
shared Postgres outbox table, not in-process channels.

### `services/voice` (Pillar 3)

Owns voice-profile build (raw text → `VoiceProfile`) and sequence
generation (template + profile → multi-email `Sequence`). Two job
state machines: `voice_ingest_jobs` (source ingest) and
`voice_sequence_jobs` (Gemini generation runs).

Both expose `POST /v1/voice/...` to kick off + `GET /v1/voice/.../jobs/{id}`
to poll. The worker goroutine drives `pending → running → succeeded/failed`
on the row with timestamps + error capture.

### `services/migration`

Read adapters per source platform (`packages/migrate/{mailchimp,
convertkit,substack,mailerlite,beehiiv,csv,...}`) feed a canonical
orchestrator that writes to Listmonk + Postgres. Translation passes
preserve subscribers, segments, automations, archives, paid
subscriptions. Verification report on every run.

### `services/automation`

Asynq-backed journey engine. Each Execution is one (automation,
subscriber, node) tuple; the engine runs the node and either acks
(terminal) or enqueues the successor. Idempotent via stable Execution
IDs derived from the tuple.

### `services/deliverability`

Inbox-reality predictor + render preview across 10 mail clients
(Gmail, Outlook, Apple Mail, …) via HCTI. Auth check helpers (SPF,
DKIM, DMARC). Reputation feeds (SNDS, Postmaster Tools, SenderScore).

## Why Listmonk over HTTP only

`LICENSE-BOUNDARY.md` is the governing contract: Moosewave services never
import a `github.com/knadh/listmonk` Go package. The separately deployed
upstream Listmonk process is consumed only through its HTTP API, which keeps
engine upgrades and application releases independently testable.

The boundary is enforced two ways:

1. Listmonk runs as a standalone container (`infra/docker-compose.yml`).
2. Moosewave talks to it through `apps/api/internal/listmonk/client.go`
   — a thin HTTP wrapper around `/api/subscribers`, `/api/campaigns`,
   `/api/tx`, etc.

In return, Moosewave wraps Listmonk with multi-tenancy, idempotency,
RLS-isolated mirrors, voice generation, migration tooling, mobile, and
SDKs — none of which Listmonk has.

## Persistence layout

Migrations live in `infra/migrations/00NN_*.sql` and are applied at
gateway boot via `migrationrunner`. Numbering is monotonic; never
re-number, never edit a landed migration — write a new one.

Notable tables:

- `tenants`, `users` — bootstrap (0001)
- `subscribers` — RLS, jsonb `custom_fields` + `merge_fields`
- `campaigns`, `campaign_report_events` — analytics source-of-truth
- `outbox_events` — transactional outbox (0035)
- `voice_*` — sources, items, profiles, sequences, jobs (0010, 0037, 0040)
- `tenant_custom_fields` — registry that drives `customfields.Validator` (0036)
- `webhooks`, `webhook_deliveries`, secret_envelope (0017, 0039)
- `api_keys` — hashed-at-rest with HMAC pepper

## Where to add new things

| Adding… | Touches |
|---|---|
| A new HTTP endpoint | `apps/api/internal/<package>/handlers.go`, `apps/api/main.go`, `packages/openapi/openapi.yaml` |
| A new migration | `infra/migrations/00NN_*.sql` only — runner picks up at boot |
| A new outbox event kind | `outbox.Registry.Register(kind, handler)` in `main.go`, plus the kind in the producer |
| A new webhook event type | `webhooks.AllEvents`, plus a producer that calls `Dispatcher.Fire` |
| A new sibling service | `services/<name>/`, `go.work`, `infra/docker-compose.yml`, internal-token auth middleware, narrow HTTP client in `apps/api` |

## Open ground

These are the seams the project has on purpose, not as gaps:

- **Per-tenant rate limiting beyond IP-level public endpoints.** Today
  budgets/limits enforce monthly quotas; sub-second per-key throttling
  is not implemented.
- **Multi-region.** Single-region Postgres in V1; DR runbook in
  `docs/runbooks` describes the manual restore-from-snapshot path.
- **Real campaign content editor.** GrapeJS deps are in `apps/web/package.json`
  but the editor surface is partial. The send orchestrator is ready
  whenever the editor delivers HTML.
