-- 0289_form_variants.sql
--
-- Gap feature `sto-form-display-optimization` (P3, surface=send-time).
-- Inspired by Klaviyo's "Forms Display Optimization": multi-variant A/B
-- on form display timing/triggers with a Thompson-style bandit that
-- re-weights traffic toward the higher-submission-rate variant and
-- auto-promotes the winner once 95% confident.
--
-- THREE TABLES:
--
--   1. form_variants
--      Per-form variant definitions. Each row is a candidate display
--      config (delay, trigger, position, message, etc.) plus a current
--      traffic_pct that the bandit re-weights over time. Status enum
--      tracks whether the variant is exploring, promoted (winner), or
--      paused.
--
--   2. form_variant_impressions
--      Counter table — one row per (form_id, variant_id) carrying the
--      running impressions/submissions counts that the bandit reads to
--      compute conversion rate + Wald-z confidence. Updated by the
--      public form render + submit paths via UPSERT.
--
--   3. form_variant_promotions
--      Audit log of auto-promotion decisions: when a variant crossed
--      the 95% confidence threshold, what its lift was, and which
--      variant got demoted. Read-only after insert.
--
-- RLS — every new table follows the tenant_id-via-GUC idiom:
--   tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- A permissive policy lets the unauthenticated public form rendering
-- path INSERT/UPDATE impressions because at render time we already
-- know form_id (resolved via app.public_form_id binding from the same
-- request) and the counter is a write-only counter (no PII).

BEGIN;

-- ---------------------------------------------------------------------------
-- form_variants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_variants (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    -- Operator-facing short label ("control", "B", "delayed-3s"...).
    -- Unique within a form so the desktop UI can render a stable column.
    variant_label   text NOT NULL,
    -- Free-form jsonb the embed/snippet reads at render time. Recognized
    -- shape (today):
    --   {
    --     "trigger":   "load" | "scroll" | "exit-intent" | "time-on-page",
    --     "delaySeconds": integer,
    --     "scrollPct":    integer (0..100),
    --     "position":  "modal" | "inline" | "slide-in",
    --     "headline":  string,
    --     "ctaText":   string
    --   }
    -- The forms.Structure jsonb is *not* overridden — display_config is
    -- additive layout/trigger metadata only. Future shapes layered in here.
    display_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Bandit-controlled traffic weight, 0..100. The sum across active
    -- variants per form is normalized to 100 by the bandit on every
    -- re-weight pass (see form_variants/bandit.go). On insert we
    -- default to evenly-split among N existing variants — see the
    -- TRIGGER below.
    traffic_pct     integer NOT NULL DEFAULT 50
                        CHECK (traffic_pct >= 0 AND traffic_pct <= 100),
    -- Status: 'exploring' is the default (bandit is actively varying
    -- traffic). 'promoted' is the auto-winner — bandit pins its
    -- traffic_pct to 100 and demotes peers. 'paused' = operator
    -- pulled it (no traffic, no measurement).
    status          text NOT NULL DEFAULT 'exploring'
                        CHECK (status IN ('exploring','promoted','paused')),
    -- When auto-promote crossed 95% confidence. NULL until promotion.
    promoted_at     timestamptz,
    -- The z-score that triggered promotion (or the last computed value).
    -- Useful for debug + the admin UI's "confidence" badge.
    last_z_score    double precision NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (form_id, variant_label)
);

CREATE INDEX IF NOT EXISTS form_variants_form_idx
    ON form_variants (form_id, status);

CREATE INDEX IF NOT EXISTS form_variants_tenant_idx
    ON form_variants (tenant_id, status);

CREATE TRIGGER form_variants_set_updated_at
    BEFORE UPDATE ON form_variants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON form_variants TO postwave_app;

ALTER TABLE form_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_variants FORCE  ROW LEVEL SECURITY;

CREATE POLICY form_variants_tenant_isolation ON form_variants
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public path may read variants for the form bound in the same tx
-- (app.public_form_id), so the embed/snippet can choose a variant
-- before the user sees the form.
CREATE POLICY form_variants_public_read ON form_variants
    AS PERMISSIVE FOR SELECT
    USING (
        form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND status IN ('exploring','promoted')
    );

-- ---------------------------------------------------------------------------
-- form_variant_impressions — counter rows the bandit reads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_variant_impressions (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    variant_id      uuid NOT NULL,
    impressions     bigint NOT NULL DEFAULT 0,
    submissions     bigint NOT NULL DEFAULT 0,
    -- Last-touch wall-clock so the bandit can run "decay older counters"
    -- in a future pass. Today we treat counters as cumulative since
    -- experiment start.
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, form_id, variant_id),
    FOREIGN KEY (tenant_id, variant_id)
        REFERENCES form_variants (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS form_variant_impressions_form_idx
    ON form_variant_impressions (form_id, variant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON form_variant_impressions TO postwave_app;

ALTER TABLE form_variant_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_variant_impressions FORCE  ROW LEVEL SECURITY;

CREATE POLICY form_variant_impressions_tenant_isolation ON form_variant_impressions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public render/submit path increments counters. The unauthenticated
-- request has already resolved (tenant_id, form_id) from the slug
-- lookup; we bind app.public_form_tenant_id + app.public_form_id in
-- that same tx so this policy is the gate.
CREATE POLICY form_variant_impressions_public_writer ON form_variant_impressions
    AS PERMISSIVE FOR INSERT
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
    );

CREATE POLICY form_variant_impressions_public_updater ON form_variant_impressions
    AS PERMISSIVE FOR UPDATE
    USING (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
    );

-- ---------------------------------------------------------------------------
-- form_variant_promotions — audit log of auto-promotions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_variant_promotions (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    winner_variant_id uuid NOT NULL,
    -- Snapshot of the metric that triggered the promotion.
    winner_rate     double precision NOT NULL,
    -- Best-of-the-rest rate at decision time.
    runner_up_rate  double precision NOT NULL,
    -- Wald-z at decision time. >= 1.96 means we crossed the 95% bar.
    z_score         double precision NOT NULL,
    -- Sample sizes at decision time. Defensive context for audit.
    winner_impressions bigint NOT NULL,
    runner_up_impressions bigint NOT NULL,
    decided_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, winner_variant_id)
        REFERENCES form_variants (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS form_variant_promotions_form_idx
    ON form_variant_promotions (form_id, decided_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON form_variant_promotions TO postwave_app;

ALTER TABLE form_variant_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_variant_promotions FORCE  ROW LEVEL SECURITY;

CREATE POLICY form_variant_promotions_tenant_isolation ON form_variant_promotions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
