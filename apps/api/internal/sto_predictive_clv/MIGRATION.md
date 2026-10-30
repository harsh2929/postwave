# sto-predictive-clv — migration recipe

This package scaffolds the Phase 3 SOTA `sto-predictive-clv` (P2, XL)
feature: Predicted CLV / Predicted Churn / Expected Date of Next Order
(EDONO) / Avg Time Between Orders (ATBO) / Predicted Gender /
Predicted Age — all surfaced as profile properties that the segment
builder and flow engine can read.

## Release status: DORMANT / UNMOUNTED

This package is source-only scaffolding, not a production capability. The API
composition root does not import it, its worker is not started, and none of the
`/api/v1/predictions/*` declarations are included in OpenAPI or an SDK. The
separate `/api/v1/predictive/*` implementation remains the mounted product
surface.

`packages/openapi/route-reachability.json` excludes this package fail closed.
Importing it from `apps/api/main.go` fails both the Go regeneration tests and
the route-parity gate. Remove that exclusion only after the deferred work below
is implemented, reviewed, mounted, documented, and exercised end to end.

What exists in the dormant scaffold:

- Migration `0344_sto_predictive_clv.sql` creating
  `subscriber_predictions` + `subscriber_prediction_runs` with RLS
  policies + partial indexes for the hot segment-builder filters.
- Repo + unmounted handlers in `internal/sto_predictive_clv/` with
  happy-path stubs for catalog / list / get / runs / recompute.
- An unstarted worker skeleton (`Worker.Loop` + `Worker.Run`) that can record
  `skipped_insufficient_data` audit rows if a future composition root starts it.

What is **explicitly deferred** (multi-week human work):

## 1. ML training pipeline

The pipeline replaces `Worker.Run`'s no-op with the real loop:

1. **Feature engineering** — for each tenant, snapshot
   `subscriber_events` + the commerce-integration `orders` table into a
   per-subscriber feature frame: lifetime spend, recency, frequency,
   T (age of relationship), event-class counts at 7d / 30d / 90d /
   180d, channel propensities (email vs SMS open rates), preference-
   center fields.
2. **CLV / EDONO / ATBO** — fit a BTYD-NBD model (frequency / recency
   / T) for the transaction rate, plus a Gamma-Gamma model for monetary
   value. Forecast over `DefaultForecastHorizonDays`. The output of the
   joint fit gives `clv_predicted_cents`, `predicted_order_count`,
   `expected_next_order_at`, and `avg_days_between_orders` for free —
   they are functions of the same posterior. Use the `lifetimes` Python
   library or a Go port; the in-Go alternative is to ship the trainer
   as a sidecar service the worker calls over gRPC.
3. **Churn risk** — fit an XGBoost classifier on labelled history
   (subscriber went 2x ATBO without an order = churned). Calibrate
   probabilities with isotonic regression so a 0.7 means roughly what
   operators expect. Cache feature importance in the
   `subscriber_prediction_runs.metrics.feature_importance` jsonb so
   the dashboard can render a SHAP-style explanation.
4. **Predicted gender** — start with first-name → gender lookup
   (a static dataset bundled into the repo, scoped to the locales
   tenants opt into). Upgrade to a fine-tuned classifier when the
   open-rate / click-through priors are well-tested.
5. **Predicted age** — opt-in only. Requires age in the preference
   center or a vendor enrichment integration (FullContact, Clearbit).
   Scaffold tolerates NULL.

Estimated effort: 3 weeks for one engineer with the lifetimes library,
4-5 weeks if we re-implement BTYD-NBD in Go. The pipeline above can
parallelize cleanly across tenants once the per-tenant feature frame
is in place — schedule the worker to process N tenants concurrently
inside a `sync.WaitGroup` with a small pool.

## 2. Segment-builder integration

The segment compiler in `internal/ai_segment_compiler` needs to learn
the new profile properties:

- `predicted_clv_cents`
- `churn_risk_score`
- `expected_next_order_at`
- `avg_days_between_orders`
- `predicted_order_count`
- `predicted_gender`
- `predicted_age_years`
- `confidence`

Each should compile to a JOIN against `subscriber_predictions` keyed
on `(tenant_id, subscriber_id)`. The partial indexes on the table
support the hot filters (`>=` on CLV, `<=` on churn, range on EDONO).

Estimated effort: 3-5 days. Parallel-safe with the ML pipeline.

## 3. Flow trigger: "churn risk crossed threshold"

`internal/voice_sequences` (the flow engine) needs a new trigger that
fires when a subscriber's `churn_risk_score` transitions across an
operator-configured threshold. Cleanly modeled as a periodic
diff-against-previous-snapshot inside the same worker that writes the
predictions — log transitions into a small `prediction_threshold_events`
table that the flow engine subscribes to via the existing event bus.

Estimated effort: 1 week. Sequential to the ML pipeline (needs real
scores) but parallel to the segment-builder integration.

## 4. Backfill + drift monitoring

- Backfill: on first deploy + on first commerce-integration connect,
  run the worker eagerly (don't wait for the weekly tick).
- Drift: compute KS distance between this run's
  `clv_predicted_cents` distribution and the previous run's. Alert in
  `audit_alerts` when KS > 0.1.

Estimated effort: 3-4 days. Parallel to everything above.

## 5. Frontend

A future `apps/desktop` Segment Builder integration needs:

- New property-picker entries for the predicted-* fields.
- Empty-state copy referencing the
  `min_data.customers` / `min_data.history_days` thresholds returned
  by `/api/v1/predictions/catalog`.
- "Last refreshed N hours ago" badge fed by `/api/v1/predictions/runs`.

Estimated effort: 1 week. Parallel to the ML pipeline.

## Architecture sketch (words)

- Postgres tables `subscriber_predictions` + `subscriber_prediction_runs`
  own the storage. Both are tenant-scoped under the standard RLS idiom
  (`NULLIF(current_setting('app.tenant_id', true), '')::uuid`) and
  bypassable by the worker via `app.outbox_worker = 'true'`.
- A weekly `Worker.Loop` enumerates tenants, fits one BTYD + one churn
  model per tenant, scores eligible subscribers, batches them into
  ~5000-row upserts, and records a run audit row with metrics + drift
  stats.
- The proposed HTTP surface is `/api/v1/predictions/*` with read-report and
  admin scopes. It is currently unmounted and must not be confused with the
  existing `/api/v1/predictive/*` heuristic surface.
- The segment compiler reads the table via JOIN; the flow engine
  subscribes to threshold-crossing events emitted by the worker; the
  desktop renders the picker + onboarding state.

## Inspired by

- **Klaviyo** — Predicted CLV / Predicted Churn / Expected Date of
  Next Order / Avg Time Between Orders / Predicted Gender suite.
- **Mailchimp** — Predictive CLV + Purchase Likelihood.
- **Braze** — Predictive Churn + Predicted Events.
- **MoEngage** — Predictions module (CLV, churn, RFM, propensity).
- **HubSpot** — Predictive lead score / deal-stage forecasting (for
  the B2B-flavored variants this scaffold can grow into).

## Total estimated remaining effort

3–5 engineer-weeks, with up to 3 sub-tasks running in parallel after
the feature-frame builder lands.

## Release verification

Before changing this status, all of these must pass with the package mounted
and its operations deliberately documented:

```sh
go test ./packages/openapi/scripts/regenerate.go ./packages/openapi/scripts/regenerate_test.go
go run ./packages/openapi/scripts/regenerate.go -check
pnpm audit:routes
```
