-- 0140_consent_receipts.sql
--
-- Consent receipt log — per-subscriber audit trail of every
-- consent change. Required for GDPR Article 7(1) (controller must
-- be able to demonstrate consent), CASL §10(1) (electronic
-- evidence retention), and most data-protection frameworks.
--
-- The existing subscribers.consent_source + consent_timestamp
-- columns capture the CURRENT consent state. This table captures
-- the full HISTORY: when did consent change, what was the prior
-- state, what was the new state, what was the source (form id /
-- API endpoint / CSV import / unsubscribe link), at what IP,
-- and what version of the privacy policy was effective at the time.
--
-- The dispatch is intentionally append-only — never UPDATE or
-- DELETE. Auditors check this table for a contiguous chain of
-- consent changes for a given subscriber.

BEGIN;

CREATE TABLE IF NOT EXISTS consent_receipts (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL,
    subscriber_id   uuid,
    subscriber_email text NOT NULL,
    -- The state change.
    prev_state      text,
    new_state       text NOT NULL CHECK (new_state IN (
        'subscribed','unsubscribed','bounced','complained','pending'
    )),
    -- Where the change came from.
    source          text NOT NULL,        -- 'form:<id>' | 'api:/v1/...' | 'csv_import' | 'unsubscribe_link' | 'admin' | 'migration:<source>'
    source_detail   text,                  -- free-form (form name, list name, etc.)
    -- Audit metadata captured at receipt time.
    ip              inet,
    user_agent      text,
    privacy_policy_version text,
    -- Optional captured-text snapshot — for double-opt-in forms,
    -- the literal copy the subscriber agreed to.
    captured_text   text,
    -- Append-only timestamp.
    at              timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "show me every consent change for this subscriber".
CREATE INDEX IF NOT EXISTS idx_consent_receipts_subscriber
    ON consent_receipts (tenant_id, subscriber_email, at DESC);

-- Auditor path: "every consent change for this tenant in this
-- time range".
CREATE INDEX IF NOT EXISTS idx_consent_receipts_tenant_time
    ON consent_receipts (tenant_id, at DESC);

GRANT SELECT, INSERT ON consent_receipts TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE consent_receipts_id_seq TO postwave_app;

ALTER TABLE consent_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON consent_receipts AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
