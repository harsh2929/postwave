-- Purge legacy generic-idempotency rows that may contain a reveal-once
-- signed-ingest credential in response_body.
--
-- The issue route is now excluded from the generic replay ledger and rejects
-- every Idempotency-Key header. This forward cleanup closes the rollout window:
-- a row written by a pre-fix application must not remain recoverable through
-- the idempotency inspector/replay endpoints until its ordinary 24-hour TTL.
-- The predicate is the exact canonical method/path stored by the middleware;
-- pending and completed rows are both removed, while every sibling route and
-- tenant remains untouched.
--
-- migration-execution: atomic
-- rollback-strategy: no-op
-- rollback-details: Reveal-once credential response bodies are intentionally unrecoverable; never restore these rows from backup during an application rollback.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
-- FORCE RLS must never turn this fleet-wide incident cleanup into a silent
-- current-tenant subset. A migrator without BYPASSRLS/superuser authority
-- fails here instead of reporting a partial purge as success.
SET LOCAL row_security = off;

DELETE FROM public.idempotency_records
 WHERE route = 'POST /api/v1/conversions/ingest-secrets';

DO $purge_verified$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.idempotency_records
         WHERE route = 'POST /api/v1/conversions/ingest-secrets'
    ) THEN
        RAISE EXCEPTION 'legacy reveal-once ingest-secret replay rows remain';
    END IF;
END
$purge_verified$;

COMMIT;
