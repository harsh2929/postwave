-- 0254_privacy_portal.sql
--
-- GAP-LS-091 / GAP-LS-093 / GAP-LS-094 / GAP-LS-149 / GAP-LS-150:
-- per-region privacy framework configuration + per-subscriber
-- GPC / do-not-sell flags. Braze Privacy Portal parity.
--
-- privacy_regions captures the cells of the GDPR / CCPA / LGPD /
-- PIPEDA / APO matrix: which framework applies in which region,
-- whether double opt-in is required, whether GPC must be honored,
-- whether do-not-sell defaults to true. The send-time eligibility
-- check (and the lookalike-sync exporters) consult these rows to
-- decide whether to drop a recipient.
--
-- subscriber_privacy_flags is the per-subscriber state derived from
-- the region rules + explicit subscriber actions (the GPC signal on
-- the web form, the do-not-sell preference center toggle). One row
-- per subscriber (PK on subscriber_id keeps the join cheap on the
-- send hot path).

BEGIN;

CREATE TABLE IF NOT EXISTS privacy_regions (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    region_code                 text NOT NULL,
    framework                   text NOT NULL CHECK (framework IN (
        'gdpr','ccpa','lgpd','pipeda','apo','other'
    )),
    requires_double_optin       boolean NOT NULL DEFAULT false,
    requires_explicit_consent   boolean NOT NULL DEFAULT false,
    do_not_sell_default         boolean NOT NULL DEFAULT false,
    gpc_honored                 boolean NOT NULL DEFAULT true,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, region_code)
);

CREATE INDEX IF NOT EXISTS privacy_regions_tenant_framework_idx
    ON privacy_regions (tenant_id, framework);

CREATE TRIGGER privacy_regions_set_updated_at
    BEFORE UPDATE ON privacy_regions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_regions TO postwave_app;

ALTER TABLE privacy_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_regions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON privacy_regions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON privacy_regions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS subscriber_privacy_flags (
    subscriber_id            uuid PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    gpc_signaled             boolean NOT NULL DEFAULT false,
    do_not_sell              boolean NOT NULL DEFAULT false,
    marketing_consent_status text NOT NULL DEFAULT 'unknown'
                             CHECK (marketing_consent_status IN (
                                 'granted','withdrawn','pending','unknown'
                             )),
    last_updated             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_privacy_flags_tenant_dns_idx
    ON subscriber_privacy_flags (tenant_id)
    WHERE do_not_sell = true;

CREATE INDEX IF NOT EXISTS subscriber_privacy_flags_tenant_gpc_idx
    ON subscriber_privacy_flags (tenant_id)
    WHERE gpc_signaled = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_privacy_flags TO postwave_app;

ALTER TABLE subscriber_privacy_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_privacy_flags FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_privacy_flags
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_privacy_flags
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
