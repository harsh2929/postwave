-- 1301_subscriber_bulk_operations_audit.sql
--
-- SUB-100-bulk-verbs — extended bulk verbs (resubscribe / add-to-list /
-- set-custom-field / update-merge-field / grant-consent / revoke-consent /
-- export-by-segment).
--
-- Every extended bulk verb writes ONE metadata row here so an operator can
-- answer "who ran what bulk verb, against which audience, and how many rows
-- did it touch?" without scraping the generic audit_log. This is distinct
-- from subscriber_bulk_recovery (1300): that table stores the *reverse-op
-- payload* for undo; this one stores the lightweight *operation metadata* for
-- the bulk-ops activity feed and post-hoc analysis.
--
-- Tenant-scoped + RLS-gated on app.tenant_id, following the shape of
-- 0303_subscriber_signup_source.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_bulk_operations_audit (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    verb                text NOT NULL CHECK (verb IN (
                            'resubscribe',
                            'add_to_list',
                            'set_custom_field',
                            'update_merge_field',
                            'grant_consent',
                            'revoke_consent',
                            'export_by_segment'
                        )),
    source              text NOT NULL DEFAULT 'explicit_ids'
                            CHECK (source IN ('explicit_ids', 'segment')),
    affected_count      integer NOT NULL DEFAULT 0,
    skipped_count       integer NOT NULL DEFAULT 0,
    -- params captures the verb-specific inputs (field name, list id, consent
    -- category, segment id, ...) for audit replay without leaking the full
    -- subscriber set.
    params              jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor               text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_bulk_operations_audit_tenant_created_idx
    ON subscriber_bulk_operations_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscriber_bulk_operations_audit_tenant_verb_idx
    ON subscriber_bulk_operations_audit (tenant_id, verb, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_bulk_operations_audit TO postwave_app;

ALTER TABLE subscriber_bulk_operations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_bulk_operations_audit FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_bulk_operations_audit;
CREATE POLICY tenant_isolation ON subscriber_bulk_operations_audit
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
