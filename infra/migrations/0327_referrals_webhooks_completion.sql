-- 0327_referrals_webhooks_completion.sql
--
-- Referrals + webhooks 2026 gap-closure bundle. Additive only:
-- nullable columns, relaxed provider enums, and new helper tables so
-- existing tenants keep their current behaviour until the API/UI opts
-- them into the new flows.

BEGIN;

-- Referral click tracking (#29) and fraud/verification/payout expansion
-- (#24, #25, #26, #27, #30, #37).
ALTER TABLE referral_codes
    ADD COLUMN IF NOT EXISTS clicks_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_clicked_at timestamptz;

CREATE TABLE IF NOT EXISTS referral_clicks (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code        text NOT NULL,
    ip          text,
    user_agent  text,
    referrer    text,
    clicked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_clicks_tenant_clicked_idx
    ON referral_clicks (tenant_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS referral_clicks_tenant_code_idx
    ON referral_clicks (tenant_id, code, clicked_at DESC);

GRANT SELECT, INSERT, DELETE ON referral_clicks TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE referral_clicks_id_seq TO postwave_app;

ALTER TABLE referral_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_clicks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON referral_clicks;
CREATE POLICY tenant_isolation ON referral_clicks
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.referrals_public_click', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.referrals_public_click', true) = 'true');

ALTER TABLE referral_programs
    ADD COLUMN IF NOT EXISTS referee_reward_kind text,
    ADD COLUMN IF NOT EXISTS referee_reward_label text,
    ADD COLUMN IF NOT EXISTS referee_reward_image_asset_id text,
    ADD COLUMN IF NOT EXISTS reward_value_cents integer,
    ADD COLUMN IF NOT EXISTS reward_currency text,
    ADD COLUMN IF NOT EXISTS reward_sku text,
    ADD COLUMN IF NOT EXISTS verification_window_days integer NOT NULL DEFAULT 0;

ALTER TABLE referral_programs
    DROP CONSTRAINT IF EXISTS referral_programs_verification_window_chk,
    ADD CONSTRAINT referral_programs_verification_window_chk
        CHECK (verification_window_days BETWEEN 0 AND 30);

ALTER TABLE referral_conversions
    ADD COLUMN IF NOT EXISTS pending_until timestamptz,
    ADD COLUMN IF NOT EXISTS credited_at timestamptz,
    ADD COLUMN IF NOT EXISTS credit_status text NOT NULL DEFAULT 'credited',
    ADD COLUMN IF NOT EXISTS variant_key text;

UPDATE referral_conversions
   SET credited_at = COALESCE(credited_at, created_at)
 WHERE credit_status = 'credited' AND credited_at IS NULL;

ALTER TABLE referral_conversions
    DROP CONSTRAINT IF EXISTS referral_conversions_credit_status_chk,
    ADD CONSTRAINT referral_conversions_credit_status_chk
        CHECK (credit_status IN ('pending','credited','rejected'));

CREATE INDEX IF NOT EXISTS referral_conversions_pending_idx
    ON referral_conversions (tenant_id, pending_until)
    WHERE credit_status = 'pending';

CREATE INDEX IF NOT EXISTS referral_conversions_variant_idx
    ON referral_conversions (tenant_id, variant_key, created_at DESC)
    WHERE variant_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_program_variants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    program_id      uuid REFERENCES referral_programs(id) ON DELETE CASCADE,
    variant_key     text NOT NULL,
    allocation_pct  integer NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 0 AND 100),
    milestones      jsonb NOT NULL DEFAULT '[]'::jsonb,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, variant_key)
);

CREATE INDEX IF NOT EXISTS referral_program_variants_tenant_idx
    ON referral_program_variants (tenant_id, active, variant_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_program_variants TO postwave_app;

ALTER TABLE referral_program_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_program_variants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON referral_program_variants;
CREATE POLICY tenant_isolation ON referral_program_variants
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Outbound webhooks: endpoint auth (#36).
ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS auth_config jsonb;

CREATE INDEX IF NOT EXISTS outbound_webhooks_auth_config_idx
    ON outbound_webhooks (tenant_id)
    WHERE auth_config IS NOT NULL;

-- Inbound transforms (#15).
ALTER TABLE inbound_webhook_endpoints
    ADD COLUMN IF NOT EXISTS transform_jq text;

ALTER TABLE inbound_routes
    ADD COLUMN IF NOT EXISTS transform_jq text;

-- Tenant deliverability provider config (#14) and long-tail providers
-- (#20). This table stores tenant-scoped receiver config; list APIs
-- redact secret-looking keys before returning the JSON bag.
CREATE TABLE IF NOT EXISTS tenant_deliverability_providers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        text NOT NULL CHECK (provider IN (
        'postmark','mailgun','ses','sendgrid','resend','sparkpost','mailersend'
    )),
    display_name    text,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider)
);

ALTER TABLE tenant_deliverability_providers
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS tenant_deliverability_providers_tenant_idx
    ON tenant_deliverability_providers (tenant_id, provider, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_deliverability_providers TO postwave_app;

ALTER TABLE tenant_deliverability_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deliverability_providers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_deliverability_providers;
CREATE POLICY tenant_isolation ON tenant_deliverability_providers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Extend existing source checks to the new deliverability receivers.
ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_source_check,
    ADD CONSTRAINT subscriber_suppressions_source_check CHECK (source IN (
        'postmark', 'mailgun', 'ses', 'sendgrid', 'resend',
        'sparkpost', 'mailersend', 'manual', 'api', 'import'
    ));

COMMIT;
