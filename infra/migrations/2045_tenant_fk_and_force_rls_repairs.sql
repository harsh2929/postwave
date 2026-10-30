-- 2045_tenant_fk_and_force_rls_repairs.sql
--
-- Forward-only repair for the migration-lint findings reviewed on 2026-09-12
-- while refreshing scripts/lint-migrations-baseline.json across migrations
-- 1769-2029. Two classes of real effective-schema gaps were found; everything
-- else in that review was either produced by a later migration already or was
-- invisible to the static linter (table-level CONSTRAINT clauses, a
-- schema-qualified public.tenants reference, policies created through
-- EXECUTE format()).
--
-- 1. Fifteen tenant tables have a NOT NULL tenant_id with no direct foreign key
--    to tenants(id). Most of them are bound to their tenant only transitively,
--    through a composite FK into a parent row that itself cascades from
--    tenants (campaign_assurance_runs, ai_regression_runs,
--    automation_lifecycle_event_inbox, campaign_send_deliveries). That chain
--    deletes the rows when a tenant is deleted, but it does not stop a write
--    from recording a tenant_id that names no tenant while the parent columns
--    name a real one, and it leaves the tenant-schema verifier
--    (scripts/lint-migrations-schema.py) unable to prove ownership table by
--    table. chat_delivery_log, landing_page_versions and
--    engagement_honeypot_fetches have no ownership edge at all: their rows
--    would survive tenant deletion. Every one of them receives the same
--    validated ON DELETE CASCADE edge every other tenant table carries.
--
-- 2. Three tables ENABLE ROW LEVEL SECURITY without FORCE. Without FORCE the
--    table owner (the migrator identity) reads and writes past every policy;
--    every other tenant table in this schema forces RLS so that no role is
--    exempt by identity alone. No later migration seeds these tables as the
--    owner, so forcing RLS changes nothing a migration relies on (the lesson
--    recorded against 0348 in checksum-supersessions.json).
--
-- Constraints are added NOT VALID and then validated. NOT VALID keeps the
-- constraint-install lock short; VALIDATE scans existing rows under the
-- lower-impact validation lock and fails closed on an orphan tenant_id.
-- VALIDATE is the orphan check on purpose: a SELECT-based preflight run by a
-- non-superuser owner would be filtered by FORCE RLS and report zero rows,
-- while VALIDATE CONSTRAINT is evaluated outside row-level security.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep the tenant ownership edges and the forced RLS in place
-- when a previous application image is restored; older binaries never wrote a
-- tenant_id that these constraints reject, and the application role
-- (postwave_app) was already subject to these tables' policies.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    target text;
    constraint_name text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'ai_regression_run_examples',
        'automation_lifecycle_event_dispatches',
        'campaign_assurance_extractions',
        'campaign_assurance_findings',
        'campaign_assurance_model_invocation_reservations',
        'campaign_assurance_model_invocation_results',
        'campaign_assurance_overrides',
        'campaign_assurance_progress_events',
        'campaign_assurance_run_artifacts',
        'campaign_assurance_run_configurations',
        'campaign_assurance_run_targets',
        'campaign_send_delivery_events',
        'chat_delivery_log',
        'engagement_honeypot_fetches',
        'landing_page_versions'
    ] LOOP
        constraint_name := target || '_tenant_id_fkey';
        IF NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint
             WHERE conrelid = ('public.' || target)::regclass
               AND conname = constraint_name
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) '
                'REFERENCES public.tenants(id) ON DELETE CASCADE NOT VALID',
                target, constraint_name
            );
        END IF;
    END LOOP;
END
$$;

ALTER TABLE public.ai_regression_run_examples
    VALIDATE CONSTRAINT ai_regression_run_examples_tenant_id_fkey;
ALTER TABLE public.automation_lifecycle_event_dispatches
    VALIDATE CONSTRAINT automation_lifecycle_event_dispatches_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_extractions
    VALIDATE CONSTRAINT campaign_assurance_extractions_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_findings
    VALIDATE CONSTRAINT campaign_assurance_findings_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_model_invocation_reservations
    VALIDATE CONSTRAINT campaign_assurance_model_invocation_reservations_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_model_invocation_results
    VALIDATE CONSTRAINT campaign_assurance_model_invocation_results_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_overrides
    VALIDATE CONSTRAINT campaign_assurance_overrides_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_progress_events
    VALIDATE CONSTRAINT campaign_assurance_progress_events_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_artifacts
    VALIDATE CONSTRAINT campaign_assurance_run_artifacts_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_configurations
    VALIDATE CONSTRAINT campaign_assurance_run_configurations_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_targets
    VALIDATE CONSTRAINT campaign_assurance_run_targets_tenant_id_fkey;
ALTER TABLE public.campaign_send_delivery_events
    VALIDATE CONSTRAINT campaign_send_delivery_events_tenant_id_fkey;
ALTER TABLE public.chat_delivery_log
    VALIDATE CONSTRAINT chat_delivery_log_tenant_id_fkey;
ALTER TABLE public.engagement_honeypot_fetches
    VALIDATE CONSTRAINT engagement_honeypot_fetches_tenant_id_fkey;
ALTER TABLE public.landing_page_versions
    VALIDATE CONSTRAINT landing_page_versions_tenant_id_fkey;

-- Each table already carries a tenant-bound permissive policy (tenant_isolation)
-- and, where a worker writes it, an explicit app.outbox_worker policy, so
-- forcing RLS removes only the owner's identity-based exemption.
ALTER TABLE public.chat_delivery_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_reversals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.landing_page_versions FORCE ROW LEVEL SECURITY;

-- Self-audit. Fail the transaction rather than record a version whose
-- promised state is not the effective state.
DO $$
DECLARE
    target text;
    missing text[] := ARRAY[]::text[];
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'ai_regression_run_examples',
        'automation_lifecycle_event_dispatches',
        'campaign_assurance_extractions',
        'campaign_assurance_findings',
        'campaign_assurance_model_invocation_reservations',
        'campaign_assurance_model_invocation_results',
        'campaign_assurance_overrides',
        'campaign_assurance_progress_events',
        'campaign_assurance_run_artifacts',
        'campaign_assurance_run_configurations',
        'campaign_assurance_run_targets',
        'campaign_send_delivery_events',
        'chat_delivery_log',
        'engagement_honeypot_fetches',
        'landing_page_versions'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint AS c
              JOIN pg_catalog.pg_attribute AS a
                ON a.attrelid = c.conrelid
               AND a.attname = 'tenant_id'
               AND NOT a.attisdropped
             WHERE c.conrelid = ('public.' || target)::regclass
               AND c.conname = target || '_tenant_id_fkey'
               AND c.contype = 'f'
               AND c.convalidated
               AND c.confrelid = 'public.tenants'::regclass
               AND c.confdeltype = 'c'
               AND c.conkey = ARRAY[a.attnum]::smallint[]
        ) THEN
            missing := missing || target;
        END IF;
    END LOOP;
    IF cardinality(missing) > 0 THEN
        RAISE EXCEPTION
            'migration 2045: validated cascading tenant FK missing on %',
            array_to_string(missing, ', ');
    END IF;

    FOREACH target IN ARRAY ARRAY[
        'chat_delivery_log', 'conversion_reversals', 'landing_page_versions'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_class
             WHERE oid = ('public.' || target)::regclass
               AND relrowsecurity
               AND relforcerowsecurity
        ) THEN
            RAISE EXCEPTION
                'migration 2045: % does not enable and force row level security', target;
        END IF;
    END LOOP;
END
$$;

COMMIT;
