-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 1633_transactional_smtp_dedup.sql — message-level dedup for the SMTP relay.
-- SMTP is at-least-once: a client that times out waiting for our 250 will
-- resubmit the identical message. We dedup on (tenant, message key) within a
-- retention window so a retry of an already-accepted message is not re-sent.
-- The key is the MIME Message-Id when present, else a hash of the raw bytes.

CREATE TABLE IF NOT EXISTS transactional_smtp_dedup (
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    dedup_key  text NOT NULL,
    seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, dedup_key)
);

-- Cleanup of expired rows (seen_at < now - window) is a range scan.
CREATE INDEX IF NOT EXISTS idx_transactional_smtp_dedup_seen
    ON transactional_smtp_dedup (seen_at);

ALTER TABLE transactional_smtp_dedup ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON transactional_smtp_dedup TO postwave_app;

-- The relay claims/releases under worker scope (it has the tenant from AUTH but
-- runs off the HTTP tenant-GUC path), so the policy admits the worker escape.
CREATE POLICY tenant_isolation ON transactional_smtp_dedup
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
