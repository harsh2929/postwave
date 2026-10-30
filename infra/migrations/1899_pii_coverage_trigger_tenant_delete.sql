-- 1899_pii_coverage_trigger_tenant_delete.sql
--
-- A tenant that ever configured PII scanning could not be deleted.
--
-- `tenant_pii_scan_config_coverage_transition` runs AFTER DELETE on
-- tenant_pii_scan_config and upserts a row into tenant_pii_scan_coverage for
-- that tenant. That is right when somebody clears their scan config: coverage
-- has to record that scanning stopped.
--
-- It is wrong when the config row is disappearing because the TENANT is being
-- deleted. `tenant_pii_scan_config.tenant_id` cascades from tenants, so by the
-- time this trigger fires the tenant row is already gone — and the coverage
-- upsert then violates tenant_pii_scan_coverage_tenant_id_fkey:
--
--   DELETE FROM tenants WHERE id = ...
--   ERROR: insert or update on table "tenant_pii_scan_coverage"
--          violates foreign key constraint "tenant_pii_scan_coverage_tenant_id_fkey"
--
-- So the delete fails, in full, every time. Tenant offboarding and GDPR erasure
-- are both blocked for any tenant that has ever touched the PII scanner, and
-- the failure surfaces as a foreign-key error naming a coverage table nobody
-- was asking about.
--
-- The fix is a single guard: on DELETE, if the tenant no longer exists, there
-- is nothing to record coverage FOR. Writing history for a tenant that has been
-- erased would also be the wrong outcome even if the FK permitted it — erasure
-- means the rows go away, not that a last observation about them is filed.
--
-- Deliberately NOT done by dropping the FK or by making the coverage row
-- nullable: the constraint is correct, and the trigger asking for something
-- impossible is the actual defect.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_pii_scan_config_coverage_transition()
RETURNS trigger
LANGUAGE plpgsql
-- PRESERVED FROM 1762. `CREATE OR REPLACE FUNCTION` resets every attribute
-- that is not restated, so omitting these silently downgrades the function
-- to SECURITY INVOKER with a default search_path — which would break it the
-- moment it touches a table the calling role cannot write, and drops a
-- search_path hardening that exists to stop schema shadowing.
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    row_tenant_id uuid;
    was_enabled boolean := false;
    now_enabled boolean := false;
    active_scan_contract text;
    runtime_availability text := 'unknown';
BEGIN
    -- THE TENANT-CASCADE CASE.
    --
    -- tenant_pii_scan_config.tenant_id cascades from tenants, so when a tenant
    -- is deleted this trigger fires AFTER the tenant row is already gone. The
    -- coverage upsert below then violates
    -- tenant_pii_scan_coverage_tenant_id_fkey and the whole DELETE fails —
    -- which made every tenant that ever configured PII scanning undeletable,
    -- blocking offboarding and GDPR erasure.
    --
    -- If the tenant no longer exists there is nothing to record coverage FOR.
    -- Filing a last observation about an erased tenant would be the wrong
    -- outcome even if the constraint allowed it.
    -- Nested rather than `TG_OP = 'DELETE' AND NOT EXISTS (...)`: PostgreSQL
    -- does not guarantee short-circuit evaluation of AND, so the combined form
    -- runs the tenants lookup on every INSERT and UPDATE as well.
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
            RETURN OLD;
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        row_tenant_id := OLD.tenant_id;
        was_enabled := OLD.scan_enabled;
        now_enabled := false;
    ELSE
        row_tenant_id := NEW.tenant_id;
        now_enabled := NEW.scan_enabled;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        was_enabled := OLD.scan_enabled;
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- A subscriber write that started while no config existed holds the
        -- matching tenant row FOR KEY SHARE. Wait for it to commit before the
        -- first enable can reconcile and publish an exact snapshot.
        PERFORM tenant.id
          FROM public.tenants tenant
         WHERE tenant.id = row_tenant_id
         FOR UPDATE;
    END IF;
    IF now_enabled THEN
        -- Bind newly enabled/re-enabled tenants to the deployment-wide
        -- executable contract inside the config transaction. This means the
        -- worker's steady-state tick only repairs indexed unavailable rows;
        -- it never needs an O(tenant-count) mismatch sweep.
        SELECT runtime.scan_contract, runtime.availability_status
          INTO active_scan_contract, runtime_availability
          FROM public.pii_scan_runtime_contract runtime
         WHERE runtime.singleton
         FOR SHARE;
    END IF;

    -- Revoke active row leases before disabling coverage. This keeps the
    -- queue -> state -> coverage mutation order used by claim/completion and
    -- makes opt-out linearizable: an old worker cannot renew or commit after
    -- this config transaction. Disabling is not a scan failure, so return the
    -- claim attempt to the retry budget.
    IF NOT now_enabled THEN
        -- Cross-tenant claimers take the matching transaction-level shared
        -- fence before touching an intent. Taking the exclusive side here
        -- closes the uncommitted-claim visibility race: pre-existing claims
        -- commit and become revocable before this continues, while new claims
        -- wait until the disabled config/coverage state is committed.
        PERFORM pg_advisory_xact_lock(
            hashtextextended(row_tenant_id::text, 1762)
        );

        WITH locked AS (
            SELECT intent.tenant_id, intent.subscriber_id
              FROM public.subscriber_pii_scan_intents intent
             WHERE intent.tenant_id = row_tenant_id
               AND intent.status = 'leased'
             ORDER BY intent.available_at, intent.first_enqueued_at,
                      intent.tenant_id, intent.subscriber_id
             FOR UPDATE OF intent
        )
        UPDATE public.subscriber_pii_scan_intents intent
           SET status = 'pending',
               attempts = GREATEST(intent.attempts - 1, 0),
               available_at = now(),
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               claimed_revision = NULL,
               claimed_generation = NULL,
               last_error_code = NULL,
               dead_lettered_at = NULL,
               updated_at = now()
          FROM locked
         WHERE intent.tenant_id = locked.tenant_id
           AND intent.subscriber_id = locked.subscriber_id;

        UPDATE public.subscriber_pii_scan_states state
           SET state = 'pending',
               last_error_code = NULL,
               updated_at = now()
         WHERE state.tenant_id = row_tenant_id
           AND state.state = 'leased';
    END IF;

    INSERT INTO public.tenant_pii_scan_coverage (
        tenant_id, scan_enabled, generation, scan_contract, status, snapshot_exact,
        enable_requested_at, disabled_at, reconciliation_requested_at
    )
    VALUES (
        row_tenant_id,
        now_enabled,
        CASE WHEN now_enabled THEN 1 ELSE 0 END,
        active_scan_contract,
        CASE
            WHEN NOT now_enabled THEN 'disabled'
            WHEN runtime_availability = 'unavailable' THEN 'unavailable'
            ELSE 'backfill_pending'
        END,
        false,
        CASE WHEN now_enabled THEN now() ELSE NULL END,
        CASE WHEN now_enabled THEN NULL ELSE now() END,
        CASE WHEN now_enabled THEN now() ELSE NULL END
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
        scan_enabled = now_enabled,
        scan_contract = CASE
            WHEN now_enabled THEN active_scan_contract
            ELSE public.tenant_pii_scan_coverage.scan_contract
        END,
        generation = CASE
            WHEN now_enabled AND NOT was_enabled
                THEN public.tenant_pii_scan_coverage.generation + 1
            ELSE public.tenant_pii_scan_coverage.generation
        END,
        status = CASE
            WHEN NOT now_enabled THEN 'disabled'
            WHEN runtime_availability = 'unavailable' THEN 'unavailable'
            ELSE 'backfill_pending'
        END,
        snapshot_exact = false,
        dirty_epoch = public.tenant_pii_scan_coverage.dirty_epoch + 1,
        enable_requested_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN now()
            ELSE public.tenant_pii_scan_coverage.enable_requested_at
        END,
        disabled_at = CASE WHEN now_enabled THEN NULL ELSE now() END,
        backfill_started_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN NULL
            ELSE public.tenant_pii_scan_coverage.backfill_started_at
        END,
        backfill_completed_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN NULL
            ELSE public.tenant_pii_scan_coverage.backfill_completed_at
        END,
        reconciliation_requested_at = CASE
            WHEN now_enabled THEN now()
            ELSE public.tenant_pii_scan_coverage.reconciliation_requested_at
        END,
        reconcile_lease_owner = NULL,
        reconcile_lease_token = NULL,
        reconcile_lease_expires_at = NULL,
        reconcile_cursor = CASE
            WHEN now_enabled AND was_enabled THEN public.tenant_pii_scan_coverage.reconcile_cursor
            ELSE NULL
        END,
        updated_at = now();

    -- Disabling does not delete queued evidence. Revoked work resumes only
    -- after a new enabled generation has been seeded.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;

$fn$;

COMMIT;
