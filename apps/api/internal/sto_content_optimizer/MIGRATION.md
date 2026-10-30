# sto-content-optimizer-combinatorial-bandit — Migration Recipe

Phase 3 XL parity feature. This document captures what shipped in the
scaffold and the multi-week work that remains.

## Vendor inspiration

- **Braze Content Optimizer** — non-contextual MAB over up to 125 email
  combinations with component-level Thompson sampling. Combinations
  sharing a winning subject (or body, or CTA) pool their evidence.
- **MoEngage Dynamic Multivariate Experiment** — Bayesian bandit
  replacing fixed-split A/B with explicit warm-up and
  epsilon-exploration controls.

## Architecture sketch (in prose, no ASCII)

- The operator submits a `ComponentsManifest` (subject / header / body
  / CTA arrays of variants) against a campaign. The HTTP handler
  validates the manifest, computes the cartesian arms (≤ 125 by
  `MaxArms`), and persists three tables in a single tenant-scoped tx:
  the run row, one arm row per cartesian tuple, and a uniform
  `traffic_allocation` map.
- A background trainer worker (`Worker.Run`) wakes every minute, finds
  runs in `exploring` or `exploiting`, pulls fresh impression/conversion
  evidence from `campaign_report_events` joined to
  `email_optimizer_assignments`, updates per-component Beta(α,β)
  posteriors, derives per-arm posteriors from the component
  decomposition (the combinatorial sharing step), Thompson-samples the
  next `traffic_allocation`, and writes back.
- The sending pipeline (deferred touchpoint) consults the run's
  `traffic_allocation` when materialising a recipient batch: for each
  recipient, weighted-pick an arm, write an
  `email_optimizer_assignments` row, and render the composed message
  using the arm's `component_ids` against the manifest. The
  desktop renders the run as a Canvas-style step in the sequence
  editor — same shape as the existing `abtests` step but with the arm
  table replacing the variant table.

## What shipped in this scaffold

- Migration `infra/migrations/0346_sto_content_optimizer_combinatorial_bandit.sql`:
  three tables (`email_optimizer_runs`, `email_optimizer_arms`,
  `email_optimizer_assignments`) with the standard tenant FK +
  force-RLS policies + indexes.
- Go package `apps/api/internal/sto_content_optimizer`:
  - Data model (`OptimizerRun`, `OptimizerArm`,
    `ComponentsManifest`, `Objective`, `Status`).
  - `Repo` with `CreateRun`, `ListRunsForCampaign`, `GetRunWithArms`,
    `UpdateStatus`, `MarkCompleted`. All open `db.WithTenant`
    transactions so RLS fires.
  - HTTP handlers + `MountRoutes` registering the five surfaces.
    `CreateRun` is end-to-end happy-path: validates the manifest,
    materialises the cartesian arms at Beta(1,1), seeds a uniform
    allocation, and returns the persisted run.
  - `Worker.Run` skeleton — ticks on a configurable interval but the
    body is a no-op stub. Safe to wire into `main.go` immediately.

## Deferred (multi-week) work

### Trainer math (largest chunk; ~2 weeks)

The current `Worker.tickStub` is a no-op. The full implementation must:

1. Per tick, list runs in `exploring` / `exploiting` (sweep across
   tenants via `db.WithWorkerScope`).
2. For each run, pull events from `campaign_report_events` since the
   last tick (carry a `last_trained_at` watermark in `model_state`).
3. Join `(campaign_id, subscriber_email)` to
   `email_optimizer_assignments` to attribute the event to an arm.
   Stamp `converted_at` on the assignment row.
4. Increment arm counters: `impressions` (fresh assignments seen),
   `conversions` (newly stamped `converted_at` per objective).
5. **Component decomposition**: for each component variant `v` of
   slot `s`, accumulate α(v) = sum of conversions across every arm
   containing `v`, β(v) = sum of (impressions − conversions). Combine
   with the Beta(1,1) prior.
6. **Per-arm posterior**: for an arm with picks
   `{subject=s, header=h, body=b, cta=c}`, the combined posterior mean
   is the product (or geometric mean — needs experimentation) of the
   component means. Update `posterior_alpha`/`posterior_beta` on the
   arm row using a moment-matched Beta fit.
7. **Thompson resample**: draw one sample per arm from its updated
   Beta. Normalise to a probability vector. Apply
   `exploration_floor` (uniform-mix epsilon) to keep the worst arms
   alive. Persist as the new `traffic_allocation`.
8. **Lifecycle transitions**: when every arm has hit
   `min_impressions_per_arm` AND the top arm's posterior
   has > 0.95 probability of being the best (via a Monte-Carlo over
   the joint posterior), transition `exploring -> exploiting`.

### Sending-pipeline integration (~1 week)

- Add a hook in `campaigns` send orchestration to consult
  `traffic_allocation` when an attached optimizer run is active.
- Insert `email_optimizer_assignments` row before rendering.
- Render the composed message using the arm's `component_ids` to look
  up each variant payload from the manifest (subject text,
  header/body MJML, CTA label+url). Reuse the existing MJML compiler.

### Conversion-event source (~3 days)

- The current `campaign_report_events` covers `sent`, `opened`,
  `clicked`. The `conversion_rate` objective needs a tenant-defined
  conversion event (e.g. order placed, signup). This requires either
  reusing the existing `webhook_events_conversion` pipeline or
  exposing a "mark conversion" SDK endpoint.

### Desktop sequence-editor step (~3-4 days, frontend)

- Add a Canvas-style "Combinatorial optimizer" node in the
  `apps/desktop` sequence editor.
- Component-grid UI (5x5 max per slot).
- Live arm table showing impressions / conversions / posterior mean
  per arm — wire to `GET /api/v1/optimizer/runs/{run_id}`.

### Hardening / observability (~3 days)

- Metrics: `sto_optimizer_active_runs`,
  `sto_optimizer_arms_per_run`, `sto_optimizer_iterations_total`,
  `sto_optimizer_train_seconds`.
- Audit-log every status transition + manifest update.
- Backfill smoke tests + a property test for the cartesian
  enumeration (already deterministic in `cartesianKeys`).

## Estimated remaining effort

| Track                              | Effort      | Parallelisable? |
|------------------------------------|-------------|-----------------|
| Trainer math                       | 8-10 days   | No (single-owner) |
| Sending-pipeline integration       | 5 days      | Yes (after model is wired) |
| Conversion-event source            | 3 days      | Yes (independent) |
| Desktop sequence-editor step       | 4 days      | Yes (frontend track) |
| Hardening / observability          | 3 days      | Yes (cross-cuts) |

Two streams can run in parallel from day 1: **trainer math** (backend)
and **desktop sequence-editor step** + **conversion-event source**
(frontend / API). The **sending-pipeline integration** depends on the
trainer producing a stable `traffic_allocation`.

## References

- Migration: `infra/migrations/0346_sto_content_optimizer_combinatorial_bandit.sql`
- Package:   `apps/api/internal/sto_content_optimizer/`
- Vendor docs (external): Braze "Content Optimizer", MoEngage
  "Dynamic Multivariate Experiment".
- Existing fixed-split A/B (the thing this supersedes):
  `apps/api/internal/abtests/` + `infra/migrations/0015_ab_tests.sql`.
