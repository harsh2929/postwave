-- 0248_consent_records.sql
--
-- GAP-LS-093 / GAP-LS-094: durable consent proof + double opt-in TTL.
--
-- consent_records is the immutable per-event ledger of "when did this
-- subscriber give us permission to email them?" — the answer a GDPR
-- regulator expects within 72h of a complaint. We already have
-- consent_events (0094) for visitor-banner traffic and
-- subscribers.consent_timestamp / consent_source for the legacy
-- single-field shape. This adds the structured, append-only record
-- with IP / UA / form_id / source URL so the operator can prove
-- a specific consent action on a specific date.
--
-- double_optin_pending is the 60-day TTL store for unconfirmed
-- subscribers per Mailchimp parity. The send-time eligibility check
-- short-circuits when subscribers.status='unconfirmed' AND the
-- pending row is expired; the worker that fires every 6h sweeps
-- expired tokens and either re-sends one reminder or deletes the
-- pending row + downgrades the subscriber to disabled.

BEGIN;

CREATE TABLE IF NOT EXISTS consent_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    email           citext NOT NULL,
    channel         text NOT NULL DEFAULT 'email'
                    CHECK (channel IN ('email','sms','push','all')),
    consent_status  text NOT NULL
                    CHECK (consent_status IN ('granted','withdrawn','pending','expired')),
    source          text NOT NULL DEFAULT 'unknown'
                    CHECK (source IN (
                        'form','double_optin','single_optin','api',
                        'import','admin','preference_center','one_click',
                        'webhook','unknown'
                    )),
    source_url      text,
    form_id         uuid,
    ip_addr         inet,
    user_agent      text,
    captured_at     timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_records_tenant_email_idx
    ON consent_records (tenant_id, email, captured_at DESC);

CREATE INDEX IF NOT EXISTS consent_records_tenant_subscriber_idx
    ON consent_records (tenant_id, subscriber_id, captured_at DESC)
    WHERE subscriber_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_records_tenant_status_idx
    ON consent_records (tenant_id, consent_status, captured_at DESC);

GRANT SELECT, INSERT ON consent_records TO postwave_app;

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consent_records
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON consent_records
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Double opt-in pending tokens. expires_at is NOT NULL because the
-- 60-day TTL is the load-bearing parity with Mailchimp's behaviour;
-- the sweep worker queries the partial index below for any row
-- where confirmed_at IS NULL and (expires_at < now() OR expires_at
-- < now() + interval '6h').
CREATE TABLE IF NOT EXISTS double_optin_pending (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         citext NOT NULL,
    list_id       uuid,
    token_hash    text NOT NULL,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS double_optin_pending_tenant_email_idx
    ON double_optin_pending (tenant_id, email)
    WHERE confirmed_at IS NULL;

-- Worker-style index: drive the sweep loop without seq-scanning.
CREATE INDEX IF NOT EXISTS double_optin_pending_sweep_idx
    ON double_optin_pending (expires_at)
    WHERE confirmed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON double_optin_pending TO postwave_app;

ALTER TABLE double_optin_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE double_optin_pending FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON double_optin_pending
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON double_optin_pending
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
