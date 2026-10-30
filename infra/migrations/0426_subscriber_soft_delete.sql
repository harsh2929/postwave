-- 0426_subscriber_soft_delete.sql
--
-- SUB-009 — soft-delete (archived_at) + retention-policy reconciliation.
--
-- Today subscribers.Delete hard-DELETEs the row and writes a permanent
-- email_suppressions entry (GDPR erasure). That is correct for a DSR
-- erasure, but operators also want a reversible "archive" state — hide a
-- subscriber from the active list without destroying audit-join keys, the
-- way Mailchimp's `archived` status works (already an enum in
-- mailchimp_status / 0028 but never given a timestamp column).
--
-- This migration:
--   1. Adds subscribers.archived_at timestamptz (NULL = active). The
--      handler's Archive/Unarchive set/clear it; List/Get/Search filter
--      WHERE archived_at IS NULL by default.
--   2. Adds a partial index on (tenant_id, archived_at) so "show archived"
--      and the retention reconciler both scan only archived rows.
--   3. Creates subscriber_retention_policy (one row per tenant) holding
--      retention_days + max_archived + last_purged_at. The reconciler (a
--      later worker) joins archived subscribers against this to decide
--      what ages out; we ship the table + RLS now so the API can read/write
--      the policy.
--
-- Patterns copied from tags#0291 (archive timestamp + partial index) and
-- export_retention#0233 (per-tenant policy row). RLS GUC idiom is the
-- repo-standard NULLIF(current_setting('app.tenant_id', true), '')::uuid.
--
-- rollback-strategy: additive. archived_at left NULL on rollback is a
-- no-op for readers that ignore it. Hard rollback =
-- ALTER TABLE subscribers DROP COLUMN archived_at; DROP TABLE
-- subscriber_retention_policy.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN subscribers.archived_at IS
    'SUB-009 soft-delete marker. NULL = active. Set by the Archive path / Delete soft-delete; cleared by Unarchive. List/Get/Search filter WHERE archived_at IS NULL by default.';

-- Partial index: only archived rows are indexed, so the "show archived"
-- listing and the retention reconciler both get a tight scan while the
-- common active-only path is untouched.
CREATE INDEX IF NOT EXISTS subscribers_tenant_archived_idx
    ON subscribers (tenant_id, archived_at)
    WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriber_retention_policy (
    tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- After this many days archived, a row is eligible for the reconciler
    -- to hard-purge. 0 = never auto-purge (manual only).
    retention_days integer NOT NULL DEFAULT 0
        CHECK (retention_days >= 0),
    -- Hard cap on the count of archived rows kept per tenant. 0 = no cap.
    max_archived   integer NOT NULL DEFAULT 0
        CHECK (max_archived >= 0),
    last_purged_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE subscriber_retention_policy IS
    'SUB-009 per-tenant archived-subscriber retention policy. The reconciler joins archived subscribers (archived_at IS NOT NULL) against retention_days / max_archived to decide what ages out.';

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_retention_policy TO postwave_app;

ALTER TABLE subscriber_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_retention_policy FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_retention_policy;
CREATE POLICY tenant_isolation ON subscriber_retention_policy
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_retention_policy;
CREATE POLICY tenant_visible ON subscriber_retention_policy
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
