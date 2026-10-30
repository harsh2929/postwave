-- 2040_compliance_sequence_and_definer_search_path.sql
--
-- Close two catalogue-level regressions found by a clean-schema operational
-- run. The compliance event table has always been writable by postwave_app,
-- but its BIGSERIAL sequence was not, so every attest/revoke transition failed
-- after least-privilege cutover. Several SECURITY DEFINER functions introduced
-- after the migration-1915 sweep also omitted pg_temp from search_path. An
-- omitted pg_temp is searched first implicitly and lets a caller shadow an
-- unqualified type or relation inside the definer identity.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Retain the narrow sequence privilege and hardened function
-- search paths during application rollback; older binaries are compatible.

BEGIN;

GRANT USAGE, SELECT ON SEQUENCE compliance_program_events_id_seq TO postwave_app;

ALTER FUNCTION public.ops_campaign_assurance_runs(
    uuid, text, timestamptz, uuid, integer
) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.ops_campaign_assurance_run_detail(uuid)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.ops_campaign_assurance_run_timeline(uuid, bigint, integer)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.ops_campaign_assurance_slo_health()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.resolve_public_offer_tenant(uuid)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.support_create_internal_note_result(uuid, text, uuid, text, text)
    SET search_path = pg_catalog, public, pg_temp;

COMMIT;
