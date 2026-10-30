# Moosewave operations console

This is an internal, server-rendered control plane. It must be deployed on a
dedicated HTTPS origin behind the same authenticated edge as the Moosewave API;
it is not a customer-facing application.

## Production contract

All variables in `.env.example` are mandatory in production. A pre-start gate
exits with configuration status 78 before Next.js starts, and the runtime
instrumentation independently refuses requests, if an origin is missing, non-HTTPS, carries
credentials/path data, or if `OPS_API_ORIGIN` is not in the exact
`OPS_API_ALLOWED_HOSTS` list. Wildcards are intentionally unsupported.

The API deployment's `CORS_ALLOWED_ORIGINS` must also include the exact
`OPS_PUBLIC_ORIGIN`. That list is the API's session-cookie Origin/CSRF boundary;
omitting the ops origin correctly makes every operator write fail with 403.

The browser can contact only the console's own origin. Server-side proxying:

- forwards only the structurally valid `pw_session` cookie;
- requires an exact `Origin` and the non-simple `x-postwave-ops-csrf` header;
- bounds check-action, incident, and tenant-control requests to 20 KiB,
  action responses to 64 KiB, and board/view responses to 1 MiB;
- refuses upstream redirects and forwards only exact, schema-validated success
  fields;
- returns normalized errors instead of internal URLs or upstream bodies; and
- permits runbooks only below `OPS_RUNBOOK_BASE_URL`.

The API remains the authorization boundary: operator session, current TOTP,
platform-operator membership, trusted client-IP resolution, allowlist, audit
write, idempotency, and action bounds are all enforced there.

`GET /api/health` is process liveness. `GET /api/ready` is a non-sensitive
dependency probe that validates production configuration and requires the
canonical API's `/api/ready` response; the container health check uses the
latter and never forwards an operator credential.

## What the board claims, and what it refuses to claim

The console's oldest invariant is that staleness is derived at READ time
(`ops.Result.Effective`), so a dead reporter renders RED rather than freezing at
a confident green. Three lanes extend that from "a check cannot lie" to "the
board cannot lie by omission":

- **UNWATCHED** lists declared coverage surfaces that nothing can report on.
  Domains are declared in `internal/ops/checks/domains.go` independently of what
  watches them, so an uncovered surface is a row somebody owns rather than a
  silence mistaken for health. `board.coverage` is the same arithmetic as a
  headline, computed server-side — the console renders it and never recomputes
  it, because GREEN carries bare check IDs rather than cards and a local count
  would drop every domain whose only check is passing.
- **BLOCKED** holds checks that cannot run for a reason no engineer can fix (an
  unopened vendor account, a denied quota, an unsigned contract). Blocked is not
  red — paging an engineer about a purchase order teaches them to ignore pages —
  and a blocked check does NOT count as coverage, so its surface keeps reporting
  as unwatched. Unblocking is a pull request that deletes the `Blocked` field;
  there is deliberately no "mark unblocked" button.
- **AUTOMATIONS** summarises heartbeats emitted from inside working loops. It
  says "nothing reports here" when no heartbeat exists, rather than "all alive",
  which is what an empty set used to render as.

`queues.worker-fleet` is separate from those heartbeats on purpose. It joins
`safego.Go`'s lifecycle events against the census in `checks/workers.go`, which
proves a worker is RUNNING; only a heartbeat proves it is doing work. A
deadlocked worker satisfies the first and fails the second. The census is
source-guarded in both directions by `workers_guard_test.go`, and note its scope:
`ops.Fleet` observes its own process, so workers in their own `cmd/` binaries
must not be declared there.

`pnpm audit:ops` prints the coverage number and every unwatched domain on each
build. Coverage is REPORTED, never gated: a threshold would be met by adding a
check that always returns OK, which is worse than the gap it hides.

## Verification and ownership

Run `pnpm --filter @postwave/ops lint test typecheck build`. CI runs these on
every change. The pinned, non-root standalone container is built from the
repository root with `docker build -f apps/ops/Dockerfile .`. Security and
deployment changes under this directory require the explicit CODEOWNERS review
declared in `.github/CODEOWNERS`.
