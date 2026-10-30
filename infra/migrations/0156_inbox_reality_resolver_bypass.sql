-- 0156_inbox_reality_resolver_bypass.sql
--
-- Forward-fix for A4 (PRODUCTION_READINESS.md):
-- inboxreality/store_pg.go has two token-keyed lookups
-- (tenantOfTest, FindTestByToken) that take only a token/test_id
-- (no tenant context yet) — these run BEFORE the deliverability
-- pivot worker knows which tenant the test belongs to. The
-- inbox_reality_tests table has FORCE RLS with strict
-- tenant_isolation, so both lookups always returned ErrNotFound
-- and every Inbox Reality test silently reported "no results".
--
-- Fix: mirror the app.auth_resolver pattern with a new GUC
-- `app.inbox_reality_resolver` and a PERMISSIVE SELECT policy
-- gated on it. Callers set the GUC inside a short tx, read the
-- test row to extract tenant_id, then proceed with the normal
-- WithTenant tx for the write side.

BEGIN;

CREATE POLICY inbox_reality_tests_resolver_read
    ON inbox_reality_tests
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.inbox_reality_resolver', true) = 'true');

COMMIT;
