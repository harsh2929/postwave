-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 1632_transactional_emails.sql — the record-of-send for the public
-- transactional email API (POST /api/v1/emails, /emails/batch, SMTP relay).
-- One row per accepted send: its status, the provider message id, and (for
-- SCHEDULED sends only) the full normalized payload the worker dispatches later.

CREATE TABLE IF NOT EXISTS transactional_emails (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    from_addr     text NOT NULL,
    to_addrs      text[] NOT NULL DEFAULT '{}',
    subject       text NOT NULL DEFAULT '',
    -- queued | scheduled | sending | sent | failed | skipped
    status        text NOT NULL DEFAULT 'queued',
    scheduled_at  timestamptz,
    provider_message_id text,
    last_error    text,
    -- Full normalized SendRequest JSON — populated ONLY for scheduled sends
    -- (the worker needs it to dispatch later). '{}' for immediate sends.
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Source channel: api | batch | smtp.
    source        text NOT NULL DEFAULT 'api',
    suppressed_count int NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant recent-activity listing (GET /emails feed) + status filter.
CREATE INDEX IF NOT EXISTS idx_transactional_emails_tenant_created
    ON transactional_emails (tenant_id, created_at DESC);

-- Scheduled-dispatch worker claim: due rows, oldest first. Partial index keeps
-- it tiny (only rows still waiting to fire).
CREATE INDEX IF NOT EXISTS idx_transactional_emails_due
    ON transactional_emails (scheduled_at)
    WHERE status = 'scheduled';

ALTER TABLE transactional_emails ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON transactional_emails TO postwave_app;

-- Tenant isolation with the standard worker-scope escape (the scheduled-send
-- dispatcher runs cross-tenant under app.outbox_worker='true').
CREATE POLICY tenant_isolation ON transactional_emails
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
