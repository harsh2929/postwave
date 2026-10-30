# `sto-aeo-sensor` — Migration / Completion Plan

## Status

**Scaffolded and intentionally unmounted — full ship is multi-week.** Migration
`0350_sto_aeo_sensor.sql` and the `aeo` package land a data model, dormant HTTP
handlers, a publisher skeleton, and tenant opt-in code. No AEO route is mounted
or advertised. Real engine clients, the per-tenant rollup pull, prompt-pack
curation, caching/abuse controls, and privacy hardening are deferred.

This document is the handoff note for the engineer who picks up the
multi-week portion.

## Architecture sketch

Three layers, written in narrative form so the diagram lives where it
can be read without a renderer:

1. **Per-tenant probe ledger** (migration `0300_aeo_sensor.sql`, already
   shipped). `aeo_settings` / `aeo_prompts` / `aeo_probes` /
   `aeo_daily_rollup` / `aeo_competitors`. One brand sees its own
   ChatGPT / Gemini / Perplexity mention + citation rates plus a
   14-day rolling volatility score. RLS-active, NULLIF GUC idiom.

2. **Public industry-wide Sensor** (migration `0350`, this scaffold).
   `aeo_sensor_industries` (taxonomy seed), `aeo_tenant_industry`
   (per-tenant opt-in to a single industry + explicit
   `contribute_to_public` consent), `aeo_sensor_industry_rollup`
   (anonymized cross-tenant aggregate — NO `tenant_id` column),
   `aeo_sensor_changelog` (publish audit trail).

3. **Daily publisher** (`SensorPublisher` in `sensor_publisher.go`).
   Walks the contributing-tenants set under the `app.outbox_worker`
   GUC, groups by `industry_slug`, folds each
   `(industry, engine, day)` bucket through `AggregateRows`, computes
   rolling-window volatility via the same `Volatility` math the
   per-tenant runner uses, and writes one row per bucket. Writes a
   `aeo_sensor_changelog` audit entry per cycle.

The intended public HTTP routes live in `sensor_handlers.go`, but remain
unmounted. Their source directory is explicitly excluded by
`packages/openapi/route-reachability.json`, so dormant route declarations
cannot leak into generated OpenAPI. Tenant-scoped handler code uses standard
scope guards, but that does not make the unfinished runtime releasable.

## What this scaffold ships today

| Layer | File | Status |
|------|------|--------|
| Data model | `infra/migrations/0350_sto_aeo_sensor.sql` | shipped |
| Types | `apps/api/internal/aeo/sensor_types.go` | shipped |
| Repo | `apps/api/internal/aeo/sensor_repo.go` | shipped |
| Publisher | `apps/api/internal/aeo/sensor_publisher.go` | scaffold — see DEFERRED #1 |
| HTTP | `apps/api/internal/aeo/sensor_handlers.go` | dormant; unmounted and not advertised |
| Wiring | `apps/api/main.go` | intentionally absent; guarded by route-reachability policy |

There is no production end-to-end path today. The source-level flow can be
exercised only in focused package tests until every deferred release gate is
complete and the mount receives a fresh security/privacy review.

## DEFERRED work (the multi-week portion)

These are the items the scaffold explicitly leaves to the
follow-up engineer. Each one is callable into independently — they
can run in parallel.

### 1. Per-tenant rollup pull in `SensorPublisher.PublishOnce`

**Estimated effort: 3–5 days.**

Today the publisher iterates the contributing-tenants list and emits a
deterministic zero-rate row. The real implementation needs to:

- For each `(industry, engine, day)` bucket, open a worker-scoped tx
  per contributing tenant, set `app.tenant_id` to that tenant's UUID,
  and `SELECT mention_rate, citation_rate, sample_size FROM
  aeo_daily_rollup WHERE engine = $1 AND day = $2`.
- Collect those per-tenant tuples and pass them to `AggregateRows`.
- Watch out for the worker-scope GUC reset: see `db.WithWorkerScope`
  + the `app.tenant_id` re-bind pattern in `db/db.go` comment block
  ("Combine with WithTenantResolver…").

Parallelisable with #2 and #3.

### 2. Per-industry prompt-pack curation

**Estimated effort: 5–8 days (mostly content, some code).**

Today every contributing tenant feeds the rollup with whatever
prompts they happen to have enabled. The real Sensor should be
*industry-aware*: SaaS contributors should run a SaaS prompt pack,
Ecommerce a different pack, etc. Without this, cross-industry
comparison is noisy.

- Extend `aeo_sensor_industries` with an `industry_prompt_pack` jsonb
  column (or, better, a separate `aeo_industry_prompts` join).
- Have the publisher filter each tenant's probes to those that match
  the industry's prompt pack before aggregation.
- Author the starter packs per industry (~30 prompts × 20
  industries; bulk of the effort).

Parallelisable with #1 and #3.

### 3. Differential-privacy noise on the published series

**Estimated effort: 2–3 days + privacy review.**

`MIN_CONTRIBUTORS = 5` is a k-anonymity *floor*, not a ceiling. With
five contributors the rollup is still potentially re-identifiable
(brand X knows its own mention rate, subtracts it, and learns the
average of the remaining 4). Standard mitigation: add Laplace noise
calibrated to the per-tenant max sensitivity.

- Add `aeo_sensor_industry_rollup.noise_scale numeric` so the public
  endpoint can disclose the noise parameter.
- Apply noise in `AggregateRows` or as a post-aggregation step in
  `PublishOnce`.

Should be the *last* step of the publisher pipeline, after rollup
write but before changelog append. Privacy team review required.

### 4. Real-engine probe runner

**Estimated effort: 2–3 weeks per engine.**

This is the upstream dependency on the per-tenant `Runner` from
`runner.go`. The Sensor publisher is downstream — when the runner is
still in stub mode (today), the per-tenant `aeo_daily_rollup` rows
are zero-rate. The public surface is absent, rather than presenting synthetic
or empty results as a live product.
Once the runner ships real ChatGPT / Gemini / Perplexity drivers
(per-tenant API credentials, rate-limit shaping, outbound HTTP
allowlist), the Sensor lights up automatically.

Engines: ChatGPT (Azure OpenAI passthrough), Gemini (Vertex AI),
Perplexity (Sonar API), Copilot (Microsoft Graph / Bing-AI), Grok
(xAI public API).

This work is **not in this PR's critical path** — the Sensor schema
and publisher pipeline are ready to absorb the real data the moment
the runner is.

### 5. Public-API caching tier + rate-limit

**Estimated effort: 2–3 days.**

The dormant public handlers would hit Postgres on every request. Before any
mount or launch:

- Add `Cache-Control: public, max-age=900` to the snapshot + series
  responses (data refreshes daily anyway).
- Front the public routes with the existing edge cache layer.
- Per-IP rate-limit via the existing `middleware/ratelimit.go` shape;
  the public Sensor is a target for scrapers.

Parallelisable with #1, #2, #3.

### 6. Industry-comparison + competitor grid UI

**Estimated effort: 1–2 weeks (desktop/web app surface).**

The data shape supports it; the desktop / web Sensor page renders
need to be built. Out of scope for the API PR but worth flagging:

- `apps/desktop/src/sensor/` — public preview pane.
- `apps/web/app/sensor/aeo/` — public landing page (the Moosewave
  marketing site is the discovery surface).

Parallelisable with everything above.

## Inspiring vendors (the audit references)

- **HubSpot AEO Sensor** — the primary reference. Daily-refreshed
  industry-wide AI-search volatility index, free with email gating.
  Matches our 0–100 score shape and the per-engine breakdown.
- **HubSpot AEO** (paid) — the per-brand companion to the public
  Sensor. Maps onto our existing migration 0300 data model.
- **Profound** — pure-play AEO startup. Same per-brand
  mention / citation / volatility shape; no public Sensor companion.
- **BrightEdge AEO** — enterprise SEO suite that bolted on an AEO
  module. Per-brand only, no public industry-wide instrument.

## Completion verification (not a current runbook)

```bash
# Apply this migration locally.
go run ./apps/api/cmd/migrate up

# Confirm dormant routes remain absent during current releases.
test -z "$(rg '/api/v1/(sensor/)?aeo' packages/openapi/openapi.yaml)"
go run ./packages/openapi/scripts/regenerate.go -check
node scripts/check-route-parity.mjs
```

Only after the deferred engine, publisher, privacy, abuse, operational, and UI
work is complete should a release change remove the AEO source exclusion,
mount the reviewed handlers, curate the OpenAPI contract, and add live probes.

## Future migrations

This scaffold reserves migration **0350**. Follow-up work should
allocate fresh sequential numbers per the project's standard. The
data model is forward-compatible — the deferred items add columns to
existing tables (`industry_prompt_pack`, `noise_scale`) rather than
replacing them.
