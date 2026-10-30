-- 0113_blocklist_suppressions.sql
--
-- Records per-tenant suppression actions triggered by blocklist
-- monitoring (either automatic — via the AutoSuppressSweep — or
-- manual via POST /api/v1/monitoring/blocklist-status/.../suppress).
--
-- This sits alongside the existing per-recipient email_suppressions
-- table: that table holds individual email addresses we won't send to;
-- this one holds IP/domain-level halt decisions that gate the entire
-- sending pool. The sending dispatcher consults blocklist_suppressions
-- before picking an IP from the pool (sending/dispatcher.go).

BEGIN;

CREATE TABLE IF NOT EXISTS blocklist_suppressions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    subject_type  text NOT NULL CHECK (subject_type IN ('ip','domain')),
    subject       text NOT NULL,
    reason        text NOT NULL DEFAULT 'blocklist_auto',
    suppressed_at timestamptz NOT NULL DEFAULT now(),
    cleared_at    timestamptz,
    UNIQUE (tenant_id, subject_type, subject)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_suppressions_tenant
    ON blocklist_suppressions (tenant_id, cleared_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON blocklist_suppressions TO postwave_app;

ALTER TABLE blocklist_suppressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON blocklist_suppressions AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Background sweep + dispatcher consult run without a tenant context.
CREATE POLICY blocklist_suppressions_worker_select ON blocklist_suppressions
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY blocklist_suppressions_worker_write ON blocklist_suppressions
    AS PERMISSIVE FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
