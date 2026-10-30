-- 0006_sending_state.sql
--
-- Per-tenant Postmark Streams provisioning + IP warmup state. One row per
-- tenant; created when the tenant upgrades to the Sending tier (or higher),
-- updated as warmup advances and as Pro-tier dedicated IPs are attached.
--
-- WHY: keeps Postmark server tokens, DKIM domains, and warmup counters in
-- our own RLS-isolated table rather than the Postmark API itself, so:
--   * tenant isolation stays enforced at the DB layer,
--   * we can audit warmup-cap decisions per send,
--   * deprovisioning is a single-row DELETE.

BEGIN;

CREATE TABLE sending_state (
    tenant_id                       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tier                            text NOT NULL CHECK (tier IN ('studio', 'sending', 'pro')),
    postmark_server_id              text,
    postmark_server_token_encrypted bytea,    -- AES-GCM ciphertext, key from env (TODO: KMS).
    postmark_stream_id              text,
    dkim_domain                     text,
    dedicated_ip                    text,
    warmup_started_at               timestamptz,
    warmup_day                      int  NOT NULL DEFAULT 0,
    daily_sent                      jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { 'YYYY-MM-DD': int }
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sending_state_tier_idx ON sending_state (tier);

CREATE TRIGGER sending_state_set_updated_at
    BEFORE UPDATE ON sending_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON sending_state TO postwave_app;

ALTER TABLE sending_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_state FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sending_state
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_log already has (tenant_id, action, at) — add a partial covering
-- index for the 'sending.*' action namespace so Pro-tier audits stay snappy.
CREATE INDEX audit_log_sending_action_idx
    ON audit_log (tenant_id, at DESC)
    WHERE action LIKE 'sending.%';

COMMIT;
