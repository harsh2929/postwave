-- 1937_editor_checkpoints_retention_worker_discovery.sql
--
-- Let the retention worker DISCOVER tenants that hold abandoned drafts.
--
-- The consolidated retention sweeper enumerates tenants once per tick and then
-- re-enters a tenant-scoped transaction per class. That discovery scan binds
-- `app.outbox_worker` and a no-tenant sentinel for `app.tenant_id`, so a table
-- whose RESTRICTIVE policy demands `tenant_id = app.tenant_id` returns nothing
-- to it. editor_checkpoints is such a table (migration 1878), which means
-- adding it to the discovery union alone changes nothing: verified against a
-- tenant holding one 90-day-old checkpoint, the union still returned 0 rows.
-- The class would look wired and sweep nobody — the same inert-mechanism
-- failure the sweep exists to close.
--
-- WHY NOT SIMPLY LOOSEN tenant_isolation, as migration 1787 did for
-- inbound_events. That table's permissive side is still tenant-scoped and its
-- writes are pinned by a separate append-only RESTRICTIVE policy, so widening
-- the restrictive USING only widened SELECT. Here `tenant_visible` is
-- PERMISSIVE FOR ALL USING (true), so the RESTRICTIVE policy is the ONLY thing
-- keeping one tenant's drafts away from another's connection: widening it for
-- ALL commands would hand any worker-scoped transaction cross-tenant UPDATE and
-- DELETE over customer text. The worker needs to read tenant_ids and nothing
-- else.
--
-- So the widening is re-tightened per command. RESTRICTIVE policies AND
-- together, and a policy declared FOR UPDATE / FOR DELETE applies only to that
-- command, so SELECT sees the widened rule alone while UPDATE and DELETE see
-- both and stay tenant-only. INSERT is unaffected: it is governed by WITH
-- CHECK, which is left tenant-only here.
--
-- rollback-strategy: no-op - restoring the previous tenant_isolation policy and
-- dropping the two command-scoped policies returns the table to its 1878
-- behaviour; only tenant discovery for this class regresses.

BEGIN;

-- Widened for reads. WITH CHECK stays tenant-only, so no worker-scoped
-- transaction can write a row belonging to another tenant.
ALTER POLICY tenant_isolation ON editor_checkpoints
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

-- Re-tighten the two commands whose row visibility comes from USING. Without
-- these, the widening above would also let a worker-scoped transaction update
-- or delete another tenant's drafts.
DROP POLICY IF EXISTS tenant_isolation_update ON editor_checkpoints;
CREATE POLICY tenant_isolation_update ON editor_checkpoints
    AS RESTRICTIVE
    FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_delete ON editor_checkpoints;
CREATE POLICY tenant_isolation_delete ON editor_checkpoints
    AS RESTRICTIVE
    FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON POLICY tenant_isolation ON editor_checkpoints IS
    'Tenant isolation, widened for the retention worker''s cross-tenant '
    'discovery SELECT only. tenant_isolation_update and tenant_isolation_delete '
    'keep row-modifying commands tenant-scoped, and WITH CHECK here keeps writes '
    'tenant-scoped, so the worker can learn WHICH tenants hold abandoned drafts '
    'without gaining any reach over their content.';

COMMIT;
