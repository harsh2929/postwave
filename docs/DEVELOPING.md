# Developing on Moosewave

How to get a local environment up, where the conventions live, and what
to run before pushing.

## Prereqs

- **Go 1.23+** (workspace is `go.work`-managed; modules under
  `apps/api`, `services/*`, `packages/migrate`).
- **Node 20+** + **pnpm 9+** for `apps/web`, `apps/mobile`,
  `packages/sdk-ts`, etc.
- **Python 3.11+** + **Poetry** for `packages/sdk-py` (excluded from
  the JS workspace).
- **Docker + Docker Compose** for the local stack (Postgres, Redis,
  Listmonk).

## First-time setup

```bash
# JS deps
pnpm install

# Bring up Postgres + Redis + Listmonk
docker compose -f infra/docker-compose.yml up -d
# (the full stack with all services lives in docker-compose.full.yml)

# Apply migrations and seed
docker exec postwave-postgres psql -U postgres -d postwave -f /tmp/dev-seed.sql
# Or rely on the API gateway's startup migrationrunner which picks up
# every infra/migrations/00NN_*.sql file at boot.
```

The API gateway expects these env vars at minimum:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://postgres:public-local-demo-only@localhost:5432/postwave` for local |
| `REDIS_ADDR` | `localhost:6379` |
| `LISTMONK_URL` | `http://localhost:9000` |
| `LISTMONK_USER` / `LISTMONK_PASSWORD` | from `infra/docker-compose.yml` |
| `POSTWAVE_API_KEY_PEPPER` | any 32+ random bytes; HMAC pepper for api-key hashing |
| `POSTWAVE_INTERNAL_API_TOKEN` | shared token between api ↔ services |
| `POSTWAVE_DEFAULT_FROM_EMAIL` | fallback sender for campaigns without an explicit from |

`apps/api/.env.example` is the authoritative list.

## Run the stack

```bash
# API gateway (foreground; auto-applies migrations on boot)
cd apps/api && go run .

# Voice service (pillar 3)
cd services/voice && go run .

# Web admin
pnpm --filter @postwave/web dev

# Mobile (Expo dev client)
pnpm --filter @postwave/mobile ios     # or android
```

## The conventions that bite if you ignore them

### 1. Every business write needs `db.WithTenant`

```go
tx, err := db.WithTenant(ctx, r.Pool, tenantID)  // SETs app.tenant_id
defer tx.Rollback(ctx)
// ... your writes ...
return tx.Commit(ctx)
```

Skipping this is not a performance optimisation — it triggers RLS
`WITH CHECK` violations at INSERT time. Don't try to be clever.

### 2. Side effects after a tx commits go through the outbox

Anywhere you'd reach for "after this commits, also call Listmonk" or
"after this commits, fire a webhook", append a row to `outbox_events`
inside the same tx. The worker handles retries, DLQ, and at-least-once
delivery. The forms-confirm DOI flow is the canonical example
(`apps/api/internal/forms/repo.go:ConfirmByTokenWithOutbox`).

### 3. Sibling services don't import `apps/api/internal/*`

Cross-service events go through the `webhook.fanout` outbox kind. See
`services/migration/internal/orchestrator/fanout.go` for the pattern.
The reverse — `apps/api` calling into a sibling — uses the typed HTTP
client at `apps/api/internal/serviceproxy/`.

### 4. Listmonk is HTTP-only

Never `import "github.com/knadh/listmonk/..."`. The license boundary
is enforced by `LICENSE-BOUNDARY.md` and the `apps/api/internal/listmonk`
HTTP wrapper is the only seam.

### 5. Migrations are append-only

Drop a new file under `infra/migrations/00NN_*.sql`, don't edit existing
ones. The migrationrunner verifies sha256 checksums of applied rows
against the file content; mutating a landed migration crashes startup.
Forward-only rollback posture is explicit: add `-- rollback-strategy:
expand-contract`, `restore`, `rehearsed-job`, or `no-op` near the top of
new SQL files, plus `-- rollback-details:` when a deploy operator needs
more than the inferred additive/no-op plan.

Do not add checksum supersessions during ordinary development. The one
existing ledger entry is a release-engineering history split for a proven
populated-upgrade defect; it is exact-hash-bound, review-expiring, and checked
by both the runtime runner and immutable release verifier.

## Running tests

```bash
# Each Go module independently
cd apps/api && go test ./...
cd services/voice && go test ./...
cd services/migration && go test ./...
# ... etc

# Race detector on touched packages (recommended before pushing)
cd apps/api && go test -race -count=1 ./internal/webhooks/... ./internal/forms/... ./internal/outbox/...

# OpenAPI/route parity scripts (non-Go)
pnpm audit:openapi

# JS workspaces
pnpm -r test
```

CI runs all of the above plus `golangci-lint` and Spectral on the
OpenAPI spec. See `.github/workflows/ci.yml`.

## Adding a new endpoint

Mechanical checklist that prevents drift:

1. Handler in `apps/api/internal/<package>/handlers.go`.
2. Mount it in `apps/api/main.go` with the appropriate `apikeys.RequireScope(...)`.
3. Add the operation to `packages/openapi/openapi.yaml`.
4. Run `pnpm audit:openapi` — must show zero gateway-only or spec-only drift.
5. If the endpoint touches subscribers, confirm the subscriber parity portion
   of `pnpm audit:openapi` stays green.
6. Write an integration test or at minimum a handler-level test.
7. Update the relevant SDK resource in `packages/sdk-ts/src/resources/`
   if the endpoint is user-facing.

## Adding a new outbox event kind

```go
// 1. Add the kind constant to the producer package.
const OutboxKindMyThing = "my-thing.do-it"

// 2. Register a handler in main.go BEFORE the worker starts.
outboxRegistry.Register(myThing.OutboxKindMyThing, myThingHandler.Handle)

// 3. Add the kind to MustHave so a wiring drop crashes startup.
outboxRegistry.MustHave(forms.OutboxKindEnableListmonk, ..., myThing.OutboxKindMyThing)

// 4. Producers append in their write tx via outbox.Append{Kind: ..., Payload: ...}
```

Without step 3 (the MustHave guard), forgetting to register a handler
silently DLQs every event of that kind — exactly the bug the outbox
refactor closed for forms-confirm.

## Code style

- Default to writing **no comments**; only when the *why* is non-obvious.
- Errors are returned, not panicked, except at process startup.
- `slog` for logging; pass a `*slog.Logger` through `Deps`, fall back
  to `slog.Default()` only when nil.
- Test-first when the change is a bugfix; "write the failing test, fix
  the code, watch it go green" is the project muscle.

## Where to look for examples

- **Concise tx-bound write with outbox:** `apps/api/internal/forms/repo.go:ConfirmByTokenWithOutbox`
- **Cross-service event emission:** `services/migration/internal/orchestrator/fanout.go`
- **Job state machine with polling:** `services/voice/internal/seqjobstore/postgres.go`
- **Two-row atomic rotation (api-keys):** `apps/api/internal/apikeys/repo.go:Rotate`
- **Webhook signing:** `apps/api/internal/webhooks/dispatcher.go:DeliverHandler.deliver`
