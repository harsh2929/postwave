-- 0246_suppression_audit_log.sql
--
-- GAP-LS-008: per-row audit trail on suppression mutations. Today the
-- legacy + X1 + Mailchimp-parity tables all support hard DELETE with
-- no historical record — operators have no way to answer "who removed
-- this address from the suppression list and when?" during a
-- compliance review. This is the parity baseline for HubSpot CRM
-- activity logging on contact records.
--
-- One row per state change. The `action` column captures intent
-- (add/remove/update/expire). `source_table` records which of the
-- three suppression tables was mutated (for audit triangulation
-- before the converger backfill removes the legacy rows).
-- `payload` is the pre-mutation snapshot so a "show me what this row
-- looked like before someone deleted it" surface has the row to
-- re-render.
--
-- Writers are go-side: handlers in apps/api/internal/suppressions/
-- INSERT the audit row inside the same tx as the mutating
-- INSERT/UPDATE/DELETE. The 'expire' action is reserved for the
-- background worker that sweeps expires_at IS NOT NULL AND expires_at
-- < now() rows once it lands.

BEGIN;

CREATE TABLE IF NOT EXISTS suppression_audit (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               citext NOT NULL,
    action              text NOT NULL CHECK (action IN ('add','remove','update','expire')),
    actor_user_id       uuid,
    actor_api_key_id    uuid,
    reason              text,
    source_table        text NOT NULL CHECK (source_table IN (
        'suppressions',
        'subscriber_suppressions',
        'email_suppressions'
    )),
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS suppression_audit_tenant_created_idx
    ON suppression_audit (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS suppression_audit_tenant_email_idx
    ON suppression_audit (tenant_id, email, created_at DESC);

GRANT SELECT, INSERT ON suppression_audit TO postwave_app;

ALTER TABLE suppression_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON suppression_audit
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON suppression_audit
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
