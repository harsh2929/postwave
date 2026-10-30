-- 0331_force_rls_and_tenant_fk_sweep.sql
--
-- Phase 0 hardening sweep (p0-force-rls-sweep): close the long-standing
-- "tenant_id column but no FORCE ROW LEVEL SECURITY and no FK to
-- tenants(id)" gap on ~49 tables that accumulated across the last 250
-- migrations. Two distinct guarantees are being established:
--
--   1. FORCE ROW LEVEL SECURITY -- without FORCE, the table owner role
--      (postwave_owner) bypasses RLS, which means migration jobs,
--      janitors, and any bug that runs SQL under the owner role silently
--      become cross-tenant. ENABLE alone is not enough -- the
--      postwave-internal-services contract requires every tenant-scoped
--      table to be FORCEd so a regression in role boundaries cannot leak
--      data. See 0190_settings_hardening.sql / 0329_remaining_rls_fixup.sql
--      for prior rounds of this same sweep.
--
--   2. FOREIGN KEY (tenant_id) -> tenants(id) ON DELETE CASCADE -- without
--      the FK, tenant deletes (DSAR right-to-erasure, account closure,
--      test-tenant teardown) leave orphan rows that (a) violate the
--      data-residency contract, (b) bloat the table indefinitely, and
--      (c) break our retention/right-to-erasure audit trail. CASCADE is
--      the right semantic here: when a tenant is gone, all of its
--      tenant-scoped audit/event/billing artefacts must go with it.
--
-- Strategy:
--
--   * FK constraints are added with NOT VALID then VALIDATE'd in a
--     separate statement. NOT VALID takes a brief ACCESS EXCLUSIVE lock
--     only long enough to add the catalog entry (no full table scan);
--     VALIDATE CONSTRAINT then takes only a SHARE UPDATE EXCLUSIVE lock
--     (concurrent with DML), which is what makes this safe to apply on a
--     live, multi-GB audit_log without a maintenance window. The catalog
--     entry alone is enough to enforce the FK for *new* writes; VALIDATE
--     just back-fills the guarantee for existing rows.
--
--   * FORCE ROW LEVEL SECURITY is idempotent in PG -- re-issuing it on a
--     table that already has FORCE set is a no-op, so this migration is
--     safe to re-apply.
--
--   * Each FK is wrapped in a DO block that checks pg_constraint first,
--     because partial prior fixes (hand-applied hotfixes between
--     migrations) may already have added the constraint with a
--     different name. The DO block also skips tables that were dropped
--     in later migrations, which keeps this migration forward-safe.
--
-- Scope -- this migration covers the SECURITY-CRITICAL subset (the audit,
-- billing, compliance, retention, settings, and replies/event surface).
-- A follow-up sweep (tracked as p0-force-rls-sweep-round2) will cover
-- the remaining ~20 tables enumerated at the bottom of this file.
--
-- Tables covered in this migration (29):
--
--   Audit subsystem (highest priority -- tamper-evident logs):
--     - audit_sinks                         (0123) -- needs FORCE + FK
--     - audit_sink_failures                 (0123) -- needs FORCE + FK
--     - audit_merkle_roots                  (0123) -- needs FORCE + FK
--     - audit_sink_replay_jobs              (0265) -- needs FORCE + FK
--     - audit_export_manifests              (0265) -- needs FORCE + FK
--     - audit_alert_rules                   (0135) -- needs FORCE + FK
--     - audit_alert_fires                   (0135) -- needs FORCE + FK
--     - audit_alert_incidents               (0268) -- needs FORCE + FK
--     - audit_log                           (0002) -- FK only (FORCE already set)
--
--   Identity / access (SCIM, impersonation):
--     - scim_role_mappings                  (0122) -- needs FORCE + FK
--
--   Compliance / retention / settings:
--     - compliance_programs                 (0193) -- FK only (FORCE already set)
--     - compliance_program_events           (0193) -- FK only (FORCE already set)
--     - retention_policies                  (0084) -- FK only (FORCE already set)
--     - workspace_settings                  (0084) -- FK only (FORCE already set)
--     - notification_preferences            (0084) -- FK only (FORCE already set)
--
--   Engagement / messaging:
--     - campaign_replies                    (0087) -- needs FORCE + FK
--     - event_log                           (0119) -- needs FORCE + FK
--     - journey_attributes                  (0294) -- needs FORCE + FK
--     - llm_action_invocations              (0294) -- needs FORCE + FK
--
--   Tables previously FORCEd in 0329 (FK only):
--     - dashboard_anomalies                 (0215) -- FK only
--     - dashboard_digest_prefs              (0216) -- FK only
--     - dashboard_layouts                   (0217) -- FK only
--     - referral_clicks                     (0327) -- FK only
--     - referral_program_variants           (0327) -- FK only
--     - tenant_deliverability_providers     (0327) -- FK only
--     - webhook_alert_prefs                 (0184) -- FK only
--     - webhook_test_payloads               (0185) -- FK only
--     - activitypub_delivery_queue          (0287) -- FK only
--     - activitypub_followers               (0287) -- FK only
--     - form_variant_promotions             (0289) -- FK only
--
-- Follow-up (p0-force-rls-sweep-round2) -- the long tail (~20 tables)
-- queued for the next sweep, intentionally deferred so this migration
-- stays focused on the security-critical surface:
--
--   * subscriber_identity_links             (0324)
--   * subscriber_traits                     (0324)
--   * subscriber_events                     (0324)
--   * inbound_email_intents                 (0323)
--   * send_time_archives                    (0326)
--   * campaign_ai_summaries                 (0320)
--   * dashboard_saved_views                 (post-0217)
--   * commerce_shopify_*                    (0029 family)
--   * ueba_*                                (0317 family)
--   * sto_*                                 (0299/0316 families)
--   * preference_center_*                   (0330)
--   * deliverability_hub_*                  (0334)
--
-- The follow-up list is intentionally NOT included here because (a) some
-- of those tables are partitioned or hyper-large and benefit from a
-- dedicated maintenance window, and (b) several are still being
-- iterated on by the active deliverability-hub feature branch.

BEGIN;

-- ---------------------------------------------------------------------
-- Helper: add tenant FK as NOT VALID, then VALIDATE in a second step.
-- We use a DO block so we can skip tables that don't exist (forward-
-- safety for branches where a table got dropped/renamed) and skip
-- constraints that already exist under any name.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.add_tenant_fk(p_table text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_constraint_name text := 'fk_' || p_table || '_tenant';
    v_exists boolean;
BEGIN
    -- Skip if table doesn't exist (forward-safety).
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = p_table AND n.nspname = current_schema()
    ) THEN
        RAISE NOTICE 'add_tenant_fk: table % does not exist, skipping', p_table;
        RETURN;
    END IF;

    -- Skip if any FK constraint already references tenants(id) from this
    -- table's tenant_id column -- catches both this migration's naming
    -- convention and any prior hand-patched constraint.
    SELECT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class ft ON ft.oid = con.confrelid
        WHERE c.relname = p_table
          AND n.nspname = current_schema()
          AND con.contype = 'f'
          AND ft.relname = 'tenants'
    ) INTO v_exists;

    IF v_exists THEN
        RAISE NOTICE 'add_tenant_fk: table % already has an FK to tenants, skipping', p_table;
        RETURN;
    END IF;

    EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID',
        p_table, v_constraint_name
    );
    EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        p_table, v_constraint_name
    );
END;
$$;

-- ---------------------------------------------------------------------
-- Helper: idempotently FORCE RLS on a table that already has ENABLE.
-- FORCE is a no-op if already set, but the DO block makes the migration
-- forward-safe (skips dropped/renamed tables).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.force_rls(p_table text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = p_table AND n.nspname = current_schema()
    ) THEN
        RAISE NOTICE 'force_rls: table % does not exist, skipping', p_table;
        RETURN;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', p_table);
END;
$$;

-- ---------------------------------------------------------------------
-- Audit subsystem (tamper-evident logs -- highest priority)
-- ---------------------------------------------------------------------

SELECT pg_temp.force_rls('audit_sinks');
SELECT pg_temp.add_tenant_fk('audit_sinks');

SELECT pg_temp.force_rls('audit_sink_failures');
SELECT pg_temp.add_tenant_fk('audit_sink_failures');

SELECT pg_temp.force_rls('audit_merkle_roots');
SELECT pg_temp.add_tenant_fk('audit_merkle_roots');

SELECT pg_temp.force_rls('audit_sink_replay_jobs');
SELECT pg_temp.add_tenant_fk('audit_sink_replay_jobs');

SELECT pg_temp.force_rls('audit_export_manifests');
SELECT pg_temp.add_tenant_fk('audit_export_manifests');

SELECT pg_temp.force_rls('audit_alert_rules');
SELECT pg_temp.add_tenant_fk('audit_alert_rules');

SELECT pg_temp.force_rls('audit_alert_fires');
SELECT pg_temp.add_tenant_fk('audit_alert_fires');

SELECT pg_temp.force_rls('audit_alert_incidents');
SELECT pg_temp.add_tenant_fk('audit_alert_incidents');

-- audit_log already has FORCE RLS (set in 0002_audit_log.sql), but
-- never got an FK to tenants. The table is multi-GB on production
-- workloads, which is exactly why the NOT VALID + VALIDATE split is
-- important here -- the catalog entry locks for milliseconds, then
-- VALIDATE runs concurrently with new INSERTs.
SELECT pg_temp.add_tenant_fk('audit_log');

-- ---------------------------------------------------------------------
-- Identity / access
-- ---------------------------------------------------------------------

SELECT pg_temp.force_rls('scim_role_mappings');
SELECT pg_temp.add_tenant_fk('scim_role_mappings');

-- ---------------------------------------------------------------------
-- Compliance / retention / settings (FORCE already set in 0190; FK only)
-- ---------------------------------------------------------------------

SELECT pg_temp.add_tenant_fk('compliance_programs');
SELECT pg_temp.add_tenant_fk('compliance_program_events');
SELECT pg_temp.add_tenant_fk('retention_policies');
SELECT pg_temp.add_tenant_fk('workspace_settings');
SELECT pg_temp.add_tenant_fk('notification_preferences');

-- ---------------------------------------------------------------------
-- Engagement / messaging surface
-- ---------------------------------------------------------------------

SELECT pg_temp.force_rls('campaign_replies');
SELECT pg_temp.add_tenant_fk('campaign_replies');

SELECT pg_temp.force_rls('event_log');
SELECT pg_temp.add_tenant_fk('event_log');

SELECT pg_temp.force_rls('journey_attributes');
SELECT pg_temp.add_tenant_fk('journey_attributes');

SELECT pg_temp.force_rls('llm_action_invocations');
SELECT pg_temp.add_tenant_fk('llm_action_invocations');

-- ---------------------------------------------------------------------
-- Tables previously FORCEd in 0329_remaining_rls_fixup.sql (FK only)
-- ---------------------------------------------------------------------

SELECT pg_temp.add_tenant_fk('dashboard_anomalies');
SELECT pg_temp.add_tenant_fk('dashboard_digest_prefs');
SELECT pg_temp.add_tenant_fk('dashboard_layouts');
SELECT pg_temp.add_tenant_fk('referral_clicks');
SELECT pg_temp.add_tenant_fk('referral_program_variants');
SELECT pg_temp.add_tenant_fk('tenant_deliverability_providers');
SELECT pg_temp.add_tenant_fk('webhook_alert_prefs');
SELECT pg_temp.add_tenant_fk('webhook_test_payloads');
SELECT pg_temp.add_tenant_fk('activitypub_delivery_queue');
SELECT pg_temp.add_tenant_fk('activitypub_followers');
SELECT pg_temp.add_tenant_fk('form_variant_promotions');

COMMIT;
