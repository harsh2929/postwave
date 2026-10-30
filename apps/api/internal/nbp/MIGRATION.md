# Next Best Product — Migration Recipe (phase 2, scaffold)

This document captures the multi-week follow-up plan layered on top of
the phase-1 ship in `infra/migrations/0315_next_best_product_recommender.sql`
and finished by `infra/migrations/0347_sto_next_best_product.sql`.

The feature targets parity with:

- Klaviyo — **Next Best Product** (item-item collaborative filtering +
  Bloom-filter recency exclusion).
- Mailchimp — **Personalized Product Recommendations** (vendor-managed,
  Recombee-class collaborative filter).
- MoEngage — **Smart Recommendations on AWS Personalize** (managed
  service with auto-trained models).

The Moosewave shape is a **self-hosted item-item CF** as the primary
strategy, with an optional **sidecar adapter** for tenants who want a
managed model. Phase 2 adds A/B experiments between strategies and a
per-campaign performance rollup so the marketing team can measure the
lift.

## Architecture sketch

```
                       compose / send-time / transactional
                                       |
                          {{ recommended_products }}
                                       |
                                  Recommender
                                       |
        +------------------------------+------------------------------+
        |                              |                              |
ExperimentRepo (cache)         SidecarRepo / Dispatcher        Repo (anchors,
        |                              |                       bloom, similarity)
        v                              v                              |
 nbp_strategy_experiments     nbp_sidecar_endpoints         nbp_user_affinity
                                       |                       nbp_item_similarity
                                       v                       nbp_user_recent_bloom
                                  Personalize / Recombee
                                  (deferred SDK adapters)

                                      Builder (nightly)
                                        |
              +-------------------------+-------------------------+
              |                         |                         |
       Bloom refresh (shipped)   Cosine pass (DEFERRED)   Affinity pass (DEFERRED)
              |                         |                         |
              v                         v                         v
   nbp_user_recent_bloom     nbp_item_similarity         nbp_user_affinity

                                      Tracker (DEFERRED)
                                        |
                       joins nbp_recommendation_audit + email_click_events
                       + commerce_orders to fill nbp_campaign_performance
```

## What ships in this phase 2 scaffold

Data model (migration 0347):

| Table                          | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `nbp_strategy_experiments`     | A/B between recommender strategies per tenant        |
| `nbp_sidecar_endpoints`        | Vendor sidecar configuration (Personalize, etc.)     |
| `nbp_campaign_performance`     | Per-campaign impression/click/conv/revenue rollup    |

All tables follow the canonical NULLIF GUC RLS idiom and reference
`tenants(id)` with `ON DELETE CASCADE`.

Go package surface (added to `apps/api/internal/nbp/`):

- `experiments.go` — `ExperimentRepo`, `Experiment`, `Arm`,
  `HashAssign()` deterministic routing, 60s per-tenant cache for the
  render-time hot path.
- `sidecar.go` — reserved endpoint row projection and repository only. No
  network adapter, dispatcher, or runtime route is exposed in this release.
- `performance.go` — `PerformanceRepo` + `CampaignPerformance` row
  shape for the dashboard widget.
- `handlers.go::MountExtended()` — opt-in HTTP wiring for experiments and
  performance reads. Sidecar configuration is deliberately excluded until
  provider recommendations and catalog sync ship together.

## Deferred work (the multi-week portion)

### 1. Cosine-similarity pass on the nightly Builder
*Owner suggestion:* infra-data team
*Estimate:* ~1.5 weeks
*Sub-tasks:*
- Map-reduce over `commerce_orders.line_items` jsonb to (anchor,
  neighbor) co-occurrence counts.
- Cosine normalisation: `support / sqrt(count(a) * count(b))`.
- Top-K trim per anchor.
- Upsert into `nbp_item_similarity`.
The recommender already falls back to popularity when the table is
empty, so this can ship independently without a feature flag.

### 2. Per-user affinity pass
*Estimate:* ~3 days
*Sub-tasks:*
- For each subscriber group orders by product with a half-life decay
  (Klaviyo uses 365 days).
- Normalise to [0, 1].
- Upsert into `nbp_user_affinity`.
Can run in parallel with (1) — same job runner, separate DAG node.

### 3. AWS Personalize sidecar adapter
*Estimate:* ~2 weeks (including catalog-sync worker)
*Sub-tasks:*
- Pull `github.com/aws/aws-sdk-go-v2/service/personalize` and
  `personalizeruntime` into `apps/api`. The SDK weighs ~8 MB so this
  is a deliberate cost decision.
- Implement `SidecarAdapter` against the two services.
- Catalog export worker: nightly dump of `commerce_products` (items
  dataset) + `commerce_orders` (interactions dataset) to S3, then
  `CreateDatasetImportJob`.
- STS-assume the configured `iam_role_arn` per call so tenants own the
  IAM permissions.

### 4. Performance tracker worker
*Estimate:* ~1 week
*Sub-tasks:*
- Watch `email_click_events` + `commerce_orders` post-send for each
  campaign that had `nbp_recommendation_audit` rows.
- Attribute revenue to the rec block (90-day click attribution window
  matches the existing dashboard rule).
- Roll up into `nbp_campaign_performance`.
- Idempotent: re-runnable so a late conversion still lands.

### 5. Recommender dispatch to experiments / sidecar
*Estimate:* ~3 days
*Sub-tasks:*
- Modify `Recommender.RecommendForSubscriber` to consult
  `ExperimentRepo.ListActive` first and route the subscriber via
  `Experiment.ResolveStrategy`.
- If the resolved strategy is `personalize`, dispatch through
  `Dispatcher.Recommend`. On `ErrSidecarNotImplemented` or any other
  error, fall back to the existing item-item CF path so the render
  is never broken.
- Stamp the chosen arm + experiment_id on the
  `nbp_recommendation_audit` row so the tracker can attribute lift.

### 6. Desktop UI surfaces
*Estimate:* ~1.5 weeks
*Sub-tasks:*
- Settings > Personalization > Experiments (table + form).
- Settings > Personalization > Sidecar (single form per provider).
- Campaign overview > Recommendation lift widget (reads
  `/api/v1/nbp/performance/{campaign_id}`).

### 7. Federation / shareback (optional)
The audit ledger already records every recommendation. If the EU AI
Act Article 50 work needs to surface "why was Alice shown product
42?", we wire `nbp_recommendation_audit` into the existing AIVS
bundle pipeline. Estimate ~3 days.

## Parallelism plan

| Task                          | Blocked by | Can run in parallel with |
| ----------------------------- | ---------- | ------------------------ |
| (1) Cosine pass               | —          | (2), (3), (6)            |
| (2) Affinity pass             | —          | (1), (3), (6)            |
| (3) Personalize adapter       | —          | (1), (2), (6)            |
| (4) Performance tracker       | (5)        | (6)                      |
| (5) Recommender dispatch      | —          | (6)                      |
| (6) Desktop UI                | —          | all                      |
| (7) AIVS shareback (optional) | (4)        | —                        |

Total remaining engineer-weeks ≈ 5–6 if (1)/(2)/(3)/(6) parallelise.

## References

- Klaviyo: [Next Best Product](https://help.klaviyo.com/hc/en-us/articles/12932505400987)
- Mailchimp: [Personalized Product Recommendations](https://mailchimp.com/help/use-product-recommendations-blocks/)
- MoEngage: [Smart Recommendations on AWS Personalize](https://www.moengage.com/blog/personalization-with-aws-personalize/)
- Internal: `apps/api/internal/nbp/types.go`, `apps/api/internal/nbp/recommender.go`,
  `infra/migrations/0315_next_best_product_recommender.sql`,
  `infra/migrations/0347_sto_next_best_product.sql`.
