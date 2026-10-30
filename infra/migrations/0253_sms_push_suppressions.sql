-- 0253_sms_push_suppressions.sql
--
-- GAP-LS-014 / GAP-LS-015 / GAP-LS-100 / GAP-LS-145 / GAP-LS-146 /
-- GAP-LS-147 / GAP-LS-148: SMS + push channel suppression schema +
-- SMS-specific quiet-hours + keyword-response tables.
--
-- sms_suppressions ALREADY exists from 0098_sms_core. We EXTEND it
-- here rather than recreate. The new columns line it up with the
-- canonical reason enum landed in 0244 and add `phone` (the raw
-- pre-normalization shape) alongside the existing `phone_e164`.
--
-- New tables in this migration:
--   - push_token_suppressions   (GAP-LS-015) — per-device push
--     channel state. Token is stored as sha256 to avoid leaking
--     APNs/FCM device identifiers into the DB.
--   - sms_quiet_hours           (GAP-LS-145) — per-tenant per-country
--     time-of-day windows. Sender package consults this before
--     dispatching SMS.
--   - sms_keyword_responses     (GAP-LS-146 / GAP-LS-147) — operator
--     copy + action for inbound SMS keywords (STOP / HELP /
--     custom). Per-message-type SMS opt-out (GAP-LS-147) is
--     supported via the `action='opt_out'` rows.

BEGIN;

-- 1. Extend sms_suppressions with the canonical reason enum + raw phone.
ALTER TABLE sms_suppressions
    ADD COLUMN IF NOT EXISTS phone text;

-- Old reason CHECK was ('opt_out','manual','carrier_complaint',
-- 'invalid_number','api'). Normalize legacy values first, then
-- replace the CHECK with the canonical-plus-SMS-specific enum.
UPDATE sms_suppressions
   SET reason = CASE lower(reason)
       WHEN 'opt_out'           THEN 'stop_keyword'
       WHEN 'manual'            THEN 'manual'
       WHEN 'carrier_complaint' THEN 'carrier_block'
       WHEN 'invalid_number'    THEN 'manual'
       WHEN 'api'               THEN 'manual'
       ELSE 'manual'
   END
 WHERE reason NOT IN (
     'manual','stop_keyword','help_keyword','carrier_block',
     'complaint','quiet_hours','expired'
 );

ALTER TABLE sms_suppressions
    DROP CONSTRAINT IF EXISTS sms_suppressions_reason_check;
ALTER TABLE sms_suppressions
    ADD CONSTRAINT sms_suppressions_reason_check CHECK (reason IN (
        'manual',
        'stop_keyword',
        'help_keyword',
        'carrier_block',
        'complaint',
        'quiet_hours',
        'expired'
    ));

-- Backfill `phone` from phone_e164 for existing rows so the new
-- column has a non-null value when callers expect it.
UPDATE sms_suppressions SET phone = phone_e164 WHERE phone IS NULL;

CREATE INDEX IF NOT EXISTS sms_suppressions_tenant_phone_idx
    ON sms_suppressions (tenant_id, phone)
    WHERE phone IS NOT NULL;

-- 2. push_token_suppressions ----------------------------------------------
CREATE TABLE IF NOT EXISTS push_token_suppressions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_token_hash   bytea NOT NULL,
    platform            text NOT NULL CHECK (platform IN ('apns','fcm','web')),
    reason              text NOT NULL CHECK (reason IN (
        'manual','unregistered','expired','complaint','user_opt_out'
    )),
    source              text NOT NULL DEFAULT 'webhook',
    source_event_id     text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, platform, device_token_hash)
);

CREATE INDEX IF NOT EXISTS push_token_suppressions_tenant_platform_idx
    ON push_token_suppressions (tenant_id, platform);

CREATE UNIQUE INDEX IF NOT EXISTS push_token_suppressions_source_event_unique
    ON push_token_suppressions (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON push_token_suppressions TO postwave_app;

ALTER TABLE push_token_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_token_suppressions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON push_token_suppressions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON push_token_suppressions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. sms_quiet_hours -------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_quiet_hours (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    country_code   text NOT NULL,
    start_local    time NOT NULL DEFAULT '21:00',
    end_local      time NOT NULL DEFAULT '09:00',
    timezone       text NOT NULL DEFAULT 'UTC',
    enabled        boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, country_code)
);

CREATE TRIGGER sms_quiet_hours_set_updated_at
    BEFORE UPDATE ON sms_quiet_hours
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON sms_quiet_hours TO postwave_app;

ALTER TABLE sms_quiet_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_quiet_hours FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sms_quiet_hours
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON sms_quiet_hours
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 4. sms_keyword_responses -------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_keyword_responses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    keyword         text NOT NULL,
    response_text   text NOT NULL,
    action          text NOT NULL DEFAULT 'custom'
                    CHECK (action IN ('opt_out','opt_in','help','custom')),
    enabled         boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, keyword)
);

CREATE TRIGGER sms_keyword_responses_set_updated_at
    BEFORE UPDATE ON sms_keyword_responses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON sms_keyword_responses TO postwave_app;

ALTER TABLE sms_keyword_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_keyword_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sms_keyword_responses
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON sms_keyword_responses
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
