-- 0094_compliance_core.sql
--
-- Durable compliance primitives. These tables turn the earlier
-- documentation/intake-only posture into auditable product state:
--
--   1. privacy_requests           — DSAR/export/deletion/correction request
--                                   lifecycle and SLA clock.
--   2. consent_events             — immutable consent/opt-out ledger.
--   3. email_compliance_profiles  — CAN-SPAM/ePrivacy sender identity gate.
--   4. privacy_incidents          — privacy/security incident clocks.
--
-- All tenant-owned tables are RLS-gated on app.tenant_id.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- privacy_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_requests (
    id                    text PRIMARY KEY,
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_type          text NOT NULL CHECK (request_type IN (
                              'data_export',
                              'account_deletion',
                              'subscriber_erasure',
                              'correction',
                              'opt_out_sale_share',
                              'opt_out_targeted_advertising',
                              'limit_sensitive_data',
                              'appeal'
                            )),
    region                text NOT NULL DEFAULT 'OTHER' CHECK (region IN ('GDPR', 'CCPA', 'LGPD', 'OTHER')),
    status                text NOT NULL DEFAULT 'queued' CHECK (status IN (
                              'queued',
                              'verifying',
                              'in_progress',
                              'blocked_legal_hold',
                              'fulfilled',
                              'rejected',
                              'cancelled',
                              'appealed'
                            )),
    requester_user_id     uuid,
    requester_email       citext,
    subject_type          text NOT NULL DEFAULT 'tenant_admin' CHECK (subject_type IN ('tenant_admin', 'subscriber', 'consumer')),
    subject_email         citext,
    requested_at          timestamptz NOT NULL DEFAULT now(),
    due_at                timestamptz NOT NULL,
    completed_at          timestamptz,
    legal_hold            boolean NOT NULL DEFAULT false,
    notes                 text,
    fulfillment           jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS privacy_requests_tenant_requested_idx
    ON privacy_requests (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS privacy_requests_tenant_status_idx
    ON privacy_requests (tenant_id, status, due_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_requests TO postwave_app;

ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON privacy_requests;
CREATE POLICY tenant_visible ON privacy_requests
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- consent_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subject_type     text NOT NULL CHECK (subject_type IN ('visitor', 'user', 'subscriber', 'workspace')),
    subject_id       text,
    subject_email    citext,
    channel          text NOT NULL CHECK (channel IN ('web', 'mobile', 'desktop', 'email', 'import', 'api')),
    category         text NOT NULL CHECK (category IN (
                         'essential',
                         'analytics',
                         'marketing',
                         'email_marketing',
                         'email_tracking',
                         'sale_share',
                         'targeted_advertising',
                         'ai_processing',
                         'sensitive_data'
                       )),
    action           text NOT NULL CHECK (action IN ('granted', 'denied', 'revoked', 'opted_out', 'imported')),
    source           text NOT NULL DEFAULT 'product',
    policy_version   text NOT NULL DEFAULT 'v1',
    preferences      jsonb NOT NULL DEFAULT '{}'::jsonb,
    proof_text       text,
    ip               inet,
    user_agent       text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_events_tenant_subject_idx
    ON consent_events (tenant_id, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consent_events_tenant_email_idx
    ON consent_events (tenant_id, subject_email, created_at DESC)
    WHERE subject_email IS NOT NULL;

GRANT SELECT, INSERT ON consent_events TO postwave_app;

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON consent_events;
CREATE POLICY tenant_visible ON consent_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- email_compliance_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_compliance_profiles (
    tenant_id                         uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    legal_sender_name                 text NOT NULL DEFAULT '',
    physical_address_line1            text NOT NULL DEFAULT '',
    physical_address_line2            text NOT NULL DEFAULT '',
    physical_address_city             text NOT NULL DEFAULT '',
    physical_address_region           text NOT NULL DEFAULT '',
    physical_address_postal_code      text NOT NULL DEFAULT '',
    physical_address_country          text NOT NULL DEFAULT '',
    compliance_contact_email          citext,
    default_footer_text               text NOT NULL DEFAULT '',
    list_unsubscribe_enabled          boolean NOT NULL DEFAULT true,
    one_click_unsubscribe_enabled     boolean NOT NULL DEFAULT true,
    verified_sender_domain            boolean NOT NULL DEFAULT false,
    updated_by_user_id                uuid,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_compliance_profiles TO postwave_app;

ALTER TABLE email_compliance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_compliance_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON email_compliance_profiles;
CREATE POLICY tenant_visible ON email_compliance_profiles
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- privacy_incidents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_incidents (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid REFERENCES tenants(id) ON DELETE SET NULL,
    severity                   text NOT NULL DEFAULT 'investigating' CHECK (severity IN (
                                 'investigating',
                                 'low',
                                 'medium',
                                 'high',
                                 'critical'
                               )),
    status                     text NOT NULL DEFAULT 'open' CHECK (status IN (
                                 'open',
                                 'contained',
                                 'notifications_pending',
                                 'closed'
                               )),
    detected_at                timestamptz NOT NULL DEFAULT now(),
    gdpr_72h_deadline          timestamptz,
    affected_regions           text[] NOT NULL DEFAULT '{}'::text[],
    affected_data_categories   text[] NOT NULL DEFAULT '{}'::text[],
    affected_subject_count     int,
    notification_decisions     jsonb NOT NULL DEFAULT '{}'::jsonb,
    summary                    text NOT NULL DEFAULT '',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS privacy_incidents_status_idx
    ON privacy_incidents (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS privacy_incidents_tenant_idx
    ON privacy_incidents (tenant_id, detected_at DESC)
    WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_incidents TO postwave_app;

ALTER TABLE privacy_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON privacy_incidents;
CREATE POLICY tenant_visible ON privacy_incidents
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id IS NULL OR
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id IS NULL OR
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
