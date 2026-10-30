-- 0015_ab_tests.sql
--
-- A/B testing for campaigns. Three tables:
--
--   campaign_variants         per-variant copy (subject / from-name / body)
--   campaign_variant_results  per-variant aggregate metrics, refreshed by
--                             the winner-evaluation job
--   campaign_ab_settings      per-campaign A/B configuration
--
-- All tenant-scoped with RLS + FORCE RLS + tenant_isolation, mirroring the
-- pattern in 0010_voice.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- campaign_variants
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_variants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id     uuid NOT NULL,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    variant_label   text NOT NULL,                        -- "A", "B", "C", ...
    subject         text,
    from_name       text,
    body_mjml       text,
    body_html       text,
    weight          numeric(5,2) NOT NULL DEFAULT 50.00,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, variant_label)
);

CREATE INDEX campaign_variants_tenant_campaign_idx
    ON campaign_variants (tenant_id, campaign_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_variants TO postwave_app;

ALTER TABLE campaign_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_variants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_variants
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- campaign_variant_results
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_variant_results (
    variant_id          uuid PRIMARY KEY REFERENCES campaign_variants(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL,
    recipients_count    int NOT NULL DEFAULT 0,
    delivered           int NOT NULL DEFAULT 0,
    opens               int NOT NULL DEFAULT 0,
    clicks              int NOT NULL DEFAULT 0,
    unsubscribes        int NOT NULL DEFAULT 0,
    complaints          int NOT NULL DEFAULT 0,
    winner              bool NOT NULL DEFAULT false,
    last_evaluated_at   timestamptz
);

CREATE INDEX campaign_variant_results_tenant_idx
    ON campaign_variant_results (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_variant_results TO postwave_app;

ALTER TABLE campaign_variant_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_variant_results FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_variant_results
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- campaign_ab_settings
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_ab_settings (
    campaign_id              uuid PRIMARY KEY,
    tenant_id                uuid NOT NULL,
    winner_metric            text CHECK (winner_metric IN ('open_rate','click_rate','reply_rate')),
    evaluation_window_hours  int NOT NULL DEFAULT 24,
    winner_recipients_pct    numeric(5,2) NOT NULL DEFAULT 100.00,
    winner_decided_at        timestamptz,
    winning_variant_id       uuid
);

CREATE INDEX campaign_ab_settings_tenant_idx
    ON campaign_ab_settings (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_ab_settings TO postwave_app;

ALTER TABLE campaign_ab_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_ab_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_ab_settings
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
