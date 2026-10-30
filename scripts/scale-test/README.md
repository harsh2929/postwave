# Scale Tests — Moosewave

This directory holds the load-test harnesses we run against production-like
infra in Phase 3 (and again in Phase 4 as the launch gate). They live in
`scripts/` rather than `services/` because none of them are part of the
runtime — they're operational tooling.

## Why these exact tests

The PRD's V1 SLO targets are:

- 100K-subscriber single-tenant send: complete in <10 minutes (P99 latency
  on the transactional `/api/tx` send fanout, <500ms per request).
- 50 concurrent migration discoveries: complete inside source-platform
  rate-limit headroom; no 5xx on our `services/migration` API.
- 10K simultaneous welcome-sequence enrollments: every enrollment must
  reach `state=completed` within the simulated 30-day window with zero
  losses.

Each script targets one of those three failure modes.

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) v0.50+ — load
  generator.
- Go 1.23+ — for the welcome-sequence enrollment driver.
- A staging deployment with seeded data:
  - 1 tenant with a 100K-row `subscribers` import.
  - 50 OAuth-stubbed Mailchimp accounts in the `migration_credentials`
    table.
  - The separately running upstream Listmonk image, resolved to the approved
    staging digest, with at least 4 worker pods.
- Env vars (export before running):
  - `POSTWAVE_API_URL` — AGPL-3.0-only Moosewave API base, e.g. `https://api.staging.moosewave.com`
  - `POSTWAVE_BEARER` — scoped service-account API key or short-lived stream token with the appropriate scopes
  - `LISTMONK_TX_PATH` — defaults to `/api/tx`

## How to run

```bash
# 1. Listmonk transactional send — 1-min ramp, 5-min sustain, 1-min ramp-down
k6 run scripts/scale-test/k6-listmonk-send.js

# 2. Migration discover — 50 concurrent tenants, single shot
k6 run scripts/scale-test/k6-migration-discover.js

# 3. Welcome-sequence enrollment — 10K enrollments, accelerated 30d clock
go run scripts/scale-test/scenarios/welcome-sequence.go \
   -base "$POSTWAVE_API_URL" -bearer "$POSTWAVE_BEARER" \
   -enrollments 10000 -clock-speedup 1440  # 1 simulated day per real minute

# 4. Automation events ingester — 1-min ramp to 10 RPS, 5-min sustain, 1-min ramp-down
POSTWAVE_EVENTS_HMAC_SECRET=... POSTWAVE_TENANT_ID=tnt_loadtest \
  k6 run scripts/scale-test/k6-automation-events.js
```

## What to measure

The Grafana dashboard at `scripts/scale-test/grafana-dashboard.json` is set
up to chart these:

| Metric | Source | Target |
|---|---|---|
| `tx_send_latency_p50/95/99` | k6 + Listmonk Prom exporter | P99 < 500ms; P95 < 250ms |
| `tx_send_error_rate` | k6 | < 0.1% |
| `migration_discover_p99` | k6 | < 8s (source rate-limited) |
| `automation_step_latency_p99` | services/automation `/metrics` | < 200ms |
| `automation_queue_depth` | Asynq exporter | stays bounded; drains in <2x sustain window |
| `db_active_connections` | pg_stat_activity | < 80% of pool ceiling |
| `goroutines` | Go services `/debug/pprof` | no monotonic growth |
| `mem_rss` per service | cAdvisor | no monotonic growth |
| `event_ingest_latency_p99` | k6 | < 300ms |
| `event_ingest_error_rate` | k6 | < 1% |

A run is **green** when every target above is met for the entire sustain
window.

## Reporting

Each script writes a JSON summary to `scripts/scale-test/runs/<timestamp>/`
that we attach to the launch-readiness ADR.
