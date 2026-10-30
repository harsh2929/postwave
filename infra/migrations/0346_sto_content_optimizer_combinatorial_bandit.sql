-- 0346_sto_content_optimizer_combinatorial_bandit.sql
--
-- Phase 3 XL feature `sto-content-optimizer-combinatorial-bandit`.
--
-- A combinatorial multi-armed bandit over (subject × header × body × CTA)
-- components for a campaign. The shape is inspired by Braze's Content
-- Optimizer (component-level Thompson sampling across up to 125 email
-- combinations, with shared learning between combinations that reuse the
-- same subject / body) and MoEngage's Dynamic Multivariate Experiment
-- (Bayesian bandit replacing a fixed-split A/B).
--
-- Postwave's existing A/B (campaign_variants in 0015) is a fixed-split
-- two-proportion z-test design — adequate for "subject A vs subject B"
-- with a 50/50 split, but cannot search a combinatorial space without
-- exploding the sample-size requirement. This migration is the data
-- model underneath a separate optimizer-run model that decomposes a
-- campaign into independently-A/B'd *components* and tracks per-component
-- conversion so a combination that shares a winning subject benefits
-- from every other combination that shares it.
--
-- TABLES
--
--   email_optimizer_runs
--     One row per (campaign × optimizer_run). A campaign can be the
--     anchor of multiple runs over its lifetime (e.g. re-run when the
--     creative changes). `components` is a jsonb manifest of the
--     component variants the operator submitted ("subject": [3 items],
--     "header": [2 items], …). `traffic_allocation` is the current
--     per-arm allocation the bandit prescribes for the next batch.
--     `model_state` is the Thompson-sampling posterior — per-component
--     Beta(α, β) parameters that the worker updates as conversion
--     evidence rolls in.
--
--   email_optimizer_arms
--     The materialised combinatorial arms = cartesian product of the
--     component variants. Each row is one concrete (subject, header,
--     body, cta) tuple with the impression / conversion counters that
--     drive the per-arm posterior. We materialise rather than recompute
--     on every assignment so the worker doesn't re-walk the product
--     space on every recipient batch — and so a future analytics surface
--     can chart per-arm convergence cheaply.
--
--   email_optimizer_assignments
--     One row per (recipient, run) recording which arm the recipient
--     was assigned to, so a click/conversion event can be attributed
--     back to the arm and to its constituent components. (The full
--     attribution worker is deferred — see MIGRATION.md.)
--
-- Tenant scoping: every table FK's to tenants(id) and is force-RLS'd
-- under the project's standard `app.tenant_id` GUC idiom (see
-- apps/api/internal/db/db.go and 0331_force_rls_and_tenant_fk_sweep).
-- An optimizer worker scope (`app.outbox_worker = true`) lets the
-- background trainer read across tenants when it processes the
-- per-tenant queue.

BEGIN;

CREATE TABLE IF NOT EXISTS email_optimizer_runs (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    -- Operator-visible name ("BFCM 2026 headline test"). Optional.
    name                 text,
    -- Optimization objective: 'open_rate' | 'click_rate' | 'conversion_rate'.
    -- Conversion-rate is the production target, but for v1 a tenant
    -- without a conversion event source can run the bandit on
    -- click-rate (cheaper signal, same math).
    objective            text NOT NULL DEFAULT 'click_rate',
    -- Lifecycle: 'draft' -> 'exploring' -> 'exploiting' -> 'completed' | 'aborted'.
    status               text NOT NULL DEFAULT 'draft',
    -- components is the operator-submitted manifest:
    --   {
    --     "subject":  [{"id":"s1","text":"..."}, {"id":"s2","text":"..."}],
    --     "header":   [{"id":"h1","mjml":"..."}, ...],
    --     "body":     [{"id":"b1","mjml":"..."}, ...],
    --     "cta":      [{"id":"c1","label":"Shop","url":"..."}, ...]
    --   }
    -- The materialised arms are the cartesian product. We bound the
    -- total to 125 combinations matching Braze's documented cap
    -- (enforced in the HTTP handler, not the DB).
    components           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- traffic_allocation is the current bandit prescription that the
    -- assignment worker uses for the next recipient batch. Shape:
    --   { "<arm_id>": 0.07, "<arm_id>": 0.42, ... }   -- sums to 1.0
    -- Recomputed by the worker after each posterior update.
    traffic_allocation   jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- model_state holds the per-component Thompson-sampling posterior:
    --   {
    --     "components": {
    --        "subject": { "s1": {"alpha": 12, "beta": 88}, ... },
    --        "header":  { "h1": {"alpha":  9, "beta": 41}, ... },
    --        ...
    --     },
    --     "last_trained_at": "2026-06-09T...",
    --     "iterations": 42
    --   }
    -- Component-level decomposition is what gives combinatorial
    -- sample-size relief: combinations that share a subject pool their
    -- evidence on that subject's Beta.
    model_state          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The minimum number of impressions an arm must receive before the
    -- bandit will exit pure-exploration (matches MoEngage's "warm-up"
    -- parameter). Default 100 keeps the early posterior from
    -- collapsing on a single high-variance arm.
    min_impressions_per_arm  integer NOT NULL DEFAULT 100,
    -- The fraction of traffic to keep on uniform exploration (epsilon)
    -- even after warm-up — protects against a stale posterior when the
    -- creative is edited mid-run. 0 disables.
    exploration_floor    real NOT NULL DEFAULT 0.05,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_optimizer_runs_tenant
    ON email_optimizer_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_optimizer_runs_campaign
    ON email_optimizer_runs (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_optimizer_runs_status
    ON email_optimizer_runs (tenant_id, status)
    WHERE status IN ('exploring', 'exploiting');

CREATE TABLE IF NOT EXISTS email_optimizer_arms (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid NOT NULL REFERENCES email_optimizer_runs(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- component_ids maps {component_name -> chosen_variant_id}, e.g.
    --   {"subject":"s2","header":"h1","body":"b3","cta":"c1"}
    -- Together they specify exactly one combinatorial arm.
    component_ids       jsonb NOT NULL,
    impressions         bigint NOT NULL DEFAULT 0,
    conversions         bigint NOT NULL DEFAULT 0,
    -- Per-arm posterior. Set by the worker from the per-component
    -- posteriors so we never recompute on read.
    posterior_alpha     real NOT NULL DEFAULT 1.0,
    posterior_beta      real NOT NULL DEFAULT 1.0,
    last_assigned_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_optimizer_arms_run
    ON email_optimizer_arms (run_id);
CREATE INDEX IF NOT EXISTS idx_email_optimizer_arms_tenant
    ON email_optimizer_arms (tenant_id);
-- Uniqueness: at most one row per (run, component-tuple). We index the
-- jsonb text representation rather than a hash because the worker emits
-- canonical-key JSON so this stays cheap.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_optimizer_arms_tuple
    ON email_optimizer_arms (run_id, (component_ids::text));

CREATE TABLE IF NOT EXISTS email_optimizer_assignments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid NOT NULL REFERENCES email_optimizer_runs(id) ON DELETE CASCADE,
    arm_id              uuid NOT NULL REFERENCES email_optimizer_arms(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- subscriber_email is the recipient — we keep the same string-keyed
    -- attribution column used by campaign_report_events so the
    -- attribution worker can join cleanly.
    subscriber_email    text NOT NULL,
    assigned_at         timestamptz NOT NULL DEFAULT now(),
    -- Mirrored conversion signal so the trainer doesn't have to re-join
    -- campaign_report_events on every iteration. Stamped by the
    -- attribution worker.
    converted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_optimizer_assignments_run
    ON email_optimizer_assignments (run_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_optimizer_assignments_tenant
    ON email_optimizer_assignments (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_optimizer_assignments_recipient
    ON email_optimizer_assignments (run_id, subscriber_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON
    email_optimizer_runs,
    email_optimizer_arms,
    email_optimizer_assignments
    TO postwave_app;

ALTER TABLE email_optimizer_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_optimizer_runs        FORCE  ROW LEVEL SECURITY;
ALTER TABLE email_optimizer_arms        ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_optimizer_arms        FORCE  ROW LEVEL SECURITY;
ALTER TABLE email_optimizer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_optimizer_assignments FORCE  ROW LEVEL SECURITY;

-- RLS policies — uniform per the project idiom: tenant_id matches GUC
-- OR the optimizer worker scope is engaged.

CREATE POLICY email_optimizer_runs_select ON email_optimizer_runs
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_runs_insert ON email_optimizer_runs
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_runs_update ON email_optimizer_runs
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_runs_delete ON email_optimizer_runs
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY email_optimizer_arms_select ON email_optimizer_arms
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_arms_insert ON email_optimizer_arms
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_arms_update ON email_optimizer_arms
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_arms_delete ON email_optimizer_arms
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY email_optimizer_assignments_select ON email_optimizer_assignments
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_assignments_insert ON email_optimizer_assignments
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_assignments_update ON email_optimizer_assignments
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY email_optimizer_assignments_delete ON email_optimizer_assignments
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
