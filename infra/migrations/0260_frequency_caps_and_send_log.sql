-- 0242_frequency_caps_and_send_log.sql
--
-- G16 (campaigns 2026 pack 1): tenant-level frequency caps applied at
-- campaign queue-fill time.
--
-- Closes parity with Customer.io's per-tenant global frequency caps
-- (e.g. "no more than 3 emails per recipient per 24h"). Rules are
-- evaluated inside queueCampaignCore after suppression / holdout /
-- A-B variant split and BEFORE recipient rows are written to the
-- campaigns recipient table — so the rate-limit-budget that capped
-- recipients would have consumed in the send loop stays available
-- for the rest of the audience.
--
-- Two tables:
--
--   1. frequency_cap_rules — per-tenant rules row. Empty table = no
--      caps applied (pass-through). max_sends + window_hours model
--      the policy ("max 3 sends per 24h"); label is operator-facing.
--      RLS enforces tenant isolation.
--
--   2. subscriber_send_log — append-only log of (tenant, subscriber,
--      campaign, sent_at). Source of truth for the rules query.
--      Rows are written atomically when a recipient is admitted to the
--      durable campaign queue. This conservative queue-admission ledger can
--      overcount a later delivery failure, but it cannot undercount a
--      successfully queued recipient or diverge from the queue commit. The lookup index
--      lets the queue-fill filter check N rules x M recipients
--      with a single (tenant, subscriber, sent_at DESC) scan.
--
-- Quiet-hours / per-channel caps / V2 follow-ups: deliberately not
-- shipped in this migration. The frequency_cap_rules row leaves room
-- to add a `channels text[]` column later without a breaking change
-- (default to {'email'} when the column lands).
--
-- Idempotency: both tables created with IF NOT EXISTS to keep the
-- migration replay-safe in the dev-shell-bootstrap flow.

BEGIN;

CREATE TABLE IF NOT EXISTS frequency_cap_rules (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label        text        NOT NULL DEFAULT '',
    max_sends    int         NOT NULL CHECK (max_sends > 0),
    window_hours int         NOT NULL CHECK (window_hours BETWEEN 1 AND 720),
    active       boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS frequency_cap_rules_tenant_active_idx
    ON frequency_cap_rules (tenant_id)
    WHERE active;

GRANT SELECT, INSERT, UPDATE, DELETE ON frequency_cap_rules TO postwave_app;

ALTER TABLE frequency_cap_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE frequency_cap_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON frequency_cap_rules
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON frequency_cap_rules
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only counter source-of-truth. NO updates; NO deletes except
-- when the cascading tenant or campaign delete cleans up. Retention
-- is the responsibility of the existing retention sweep package once
-- a policy is wired (follow-up).
CREATE TABLE IF NOT EXISTS subscriber_send_log (
    id                bigserial   PRIMARY KEY,
    tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email  citext      NOT NULL,
    campaign_id       uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    sent_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_send_log_lookup_idx
    ON subscriber_send_log (tenant_id, subscriber_email, sent_at DESC);

GRANT SELECT, INSERT, DELETE ON subscriber_send_log TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscriber_send_log_id_seq TO postwave_app;

ALTER TABLE subscriber_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_send_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_send_log
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_send_log
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
