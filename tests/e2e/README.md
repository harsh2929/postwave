# Moosewave E2E Test Suite

This is the harness for end-to-end Moosewave journeys. It drives the
**real** Docker stack (`infra/docker-compose.yml` +
`infra/docker-compose.full.yml`) over HTTP and asserts on the resulting
DB / audit-log state.

## Why a separate Go module

`tests/e2e/go.mod` is intentionally NOT in the root `go.work` file. The
suite must drive the stack ONLY through the public HTTP surface — if it
imported `apps/api/internal/...` it would stop testing the deployment
path and start testing types. Keeping it standalone also means
`go test ./...` from the repo root doesn't accidentally try to spin up
Docker.

## Running locally

```sh
# One-shot — brings the stack up, runs every journey, tears it down.
./tests/e2e/run.sh

# Release-candidate gate — runs the local prelaunch gate, then this suite.
pnpm test:e2e:docker:release

# Iterate on a single journey without paying the boot cost each time:
POSTWAVE_E2E_KEEP_STACK=1 ./tests/e2e/run.sh
POSTWAVE_E2E_SKIP_UP=1    ./tests/e2e/run.sh
```

Env knobs the test code reads (defaults shown):

| Var                          | Default                  |
| ---------------------------- | ------------------------ |
| `POSTWAVE_E2E_API_BASE`      | `http://localhost:8080`  |
| `POSTWAVE_E2E_WEB_BASE`      | `http://localhost:3000`  |
| `POSTWAVE_E2E_TENANT_SLUG`   | `demo`                   |
| `POSTWAVE_E2E_ADMIN_ROLE`    | `admin`                  |
| `POSTWAVE_E2E_RUN`           | unset                    |

Tenant + role headers are honored by the dev stack thanks to the
`POSTWAVE_DEV_TENANT_SLUG_HEADER=1` and `POSTWAVE_DEV_ADMIN_ROLE_HEADER=1`
env vars set on the api container — see `infra/docker-compose.full.yml`.
The runner sets `POSTWAVE_E2E_RUN=1` after it owns or explicitly reuses that
topology. Direct `go test` invocations skip journeys without this handshake so
they cannot attach to an unrelated process that happens to use port 8080.

## Journey coverage

Every journey starts with `WaitForStack` and a unique `NewTenantSlug`.
Protected-route journeys call `ProvisionTenant`, which signs up a fresh
workspace, switches the harness to `X-Tenant-Slug`, and wires
`CleanupTenant` via `t.Cleanup`.

| File                       | Journey                                                  | Status |
| -------------------------- | -------------------------------------------------------- | ------ |
| `signup_flow_test.go`      | signup → email verify → first sign-in                    | active |
| `campaign_flow_test.go`    | create campaign → sandbox send → audit                   | active |
| `migration_flow_test.go`   | list sources → start migration → verify                  | active |
| `subscriber_flow_test.go`  | CRUD → suppression → CSV import                          | active |
| `forms_webhooks_flow_test.go` | form publish → public submit → webhook admin           | active |
| `billing_privacy_flow_test.go` | billing state/links → DSAR/deletion workflow          | active |

The release wrapper at `scripts/release/local-docker-e2e.sh` runs the
prelaunch static/test gate first, then this real-Docker suite. Set
`POSTWAVE_RELEASE_E2E_SMOKE=1` to run the Playwright local smoke suite after
the Go E2E journeys while the stack is still available.

## CI

`.github/workflows/e2e.yml` runs the suite on push to `main` and via
manual `workflow_dispatch`. Release candidates should also run
`pnpm test:e2e:docker:release` locally before a tag is cut.

## Hard rules for journey authors

1. **No imports from `apps/api` or `services/*`.** Talk to the stack
   over HTTP. Type drift between the running container image and a
   freshly-recompiled package is exactly the kind of bug e2e exists to
   catch.
2. **One tenant per protected-route test, fresh slug.** Concurrent runs
   (CI matrix, local iteration) must not share state. `ProvisionTenant`
   signs up the workspace; `CleanupTenant` is the teardown hook.
3. **Real Docker, not testcontainers.** The whole point is to catch
   regressions in the actual `docker-compose.full.yml` deployment path.
   Don't substitute a single-binary in-process stand-in.
4. **Assertions on observed state, not just HTTP 200.** A passing
   request with no audit row is a regression.
