-- 0209_klaviyo_deliverability_routing_entitlements.sql
--
-- Klaviyo parity slice KLV-14: package existing deliverability primitives into
-- routing setup workflows, click-tracking policy, hybrid dedicated/shared IP
-- warmup controls, and inbox/render-preview entitlements.

BEGIN;

CREATE TABLE deliverability_domain_setups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain             text NOT NULL,
    setup_mode         text NOT NULL DEFAULT 'static_dns'
                       CHECK (setup_mode IN ('static_dns','dynamic_delegation')),
    status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','pending_dns','verifying','ready','blocked','rolled_back')),
    dns_records        jsonb NOT NULL DEFAULT '[]',
    health_checks      jsonb NOT NULL DEFAULT '{}',
    rollback_guidance  jsonb NOT NULL DEFAULT '{}',
    ssl_status         text NOT NULL DEFAULT 'not_requested'
                       CHECK (ssl_status IN ('not_requested','pending','active','failed')),
    routing_status     text NOT NULL DEFAULT 'not_started'
                       CHECK (routing_status IN ('not_started','shared','hybrid','dedicated','paused')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, domain)
);

CREATE INDEX deliverability_domain_setups_tenant_status_idx
    ON deliverability_domain_setups (tenant_id, status, updated_at DESC);

CREATE TRIGGER deliverability_domain_setups_set_updated_at
    BEFORE UPDATE ON deliverability_domain_setups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverability_domain_setups TO postwave_app;

ALTER TABLE deliverability_domain_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_domain_setups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deliverability_domain_setups
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON deliverability_domain_setups
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE click_tracking_policies (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tracking_domain        text NOT NULL DEFAULT '',
    status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','pending_dns','ssl_pending','active','blocked')),
    ssl_status             text NOT NULL DEFAULT 'not_requested'
                           CHECK (ssl_status IN ('not_requested','pending','active','failed')),
    caa_guidance           jsonb NOT NULL DEFAULT '{}',
    disable_syntax         text[] NOT NULL DEFAULT ARRAY['data-pw-no-track="true"', 'data-postwave-no-track="true"'],
    last_untracked_report  jsonb NOT NULL DEFAULT '{}',
    settings               jsonb NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER click_tracking_policies_set_updated_at
    BEFORE UPDATE ON click_tracking_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON click_tracking_policies TO postwave_app;

ALTER TABLE click_tracking_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE click_tracking_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON click_tracking_policies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON click_tracking_policies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE ip_warmup_routing_policies (
    tenant_id                    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    status                       text NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','active','paused','completed')),
    strategy                     text NOT NULL DEFAULT 'hybrid'
                                 CHECK (strategy IN ('shared_only','hybrid','dedicated_only')),
    dedicated_pool               text NOT NULL DEFAULT 'paid_pro',
    shared_pool                  text NOT NULL DEFAULT 'shared',
    dedicated_percentage_bp      integer NOT NULL DEFAULT 0 CHECK (dedicated_percentage_bp BETWEEN 0 AND 10000),
    max_dedicated_percentage_bp  integer NOT NULL DEFAULT 10000 CHECK (max_dedicated_percentage_bp BETWEEN 0 AND 10000),
    warmup_rules                 jsonb NOT NULL DEFAULT '{}',
    last_evaluated_at            timestamptz,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER ip_warmup_routing_policies_set_updated_at
    BEFORE UPDATE ON ip_warmup_routing_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ip_warmup_routing_policies TO postwave_app;

ALTER TABLE ip_warmup_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_warmup_routing_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ip_warmup_routing_policies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON ip_warmup_routing_policies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE deliverability_entitlements (
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start              date NOT NULL DEFAULT date_trunc('month', now())::date,
    plan_tier                 text NOT NULL DEFAULT 'studio',
    inbox_tests_monthly       integer NOT NULL DEFAULT 0 CHECK (inbox_tests_monthly >= 0),
    render_previews_monthly   integer NOT NULL DEFAULT 0 CHECK (render_previews_monthly >= 0),
    inbox_tests_used          integer NOT NULL DEFAULT 0 CHECK (inbox_tests_used >= 0),
    render_previews_used      integer NOT NULL DEFAULT 0 CHECK (render_previews_used >= 0),
    overage_policy            text NOT NULL DEFAULT 'block'
                              CHECK (overage_policy IN ('block','allow_overage','contact_sales')),
    account_controls          jsonb NOT NULL DEFAULT '{}',
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_start)
);

CREATE TRIGGER deliverability_entitlements_set_updated_at
    BEFORE UPDATE ON deliverability_entitlements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverability_entitlements TO postwave_app;

ALTER TABLE deliverability_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deliverability_entitlements
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON deliverability_entitlements
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
