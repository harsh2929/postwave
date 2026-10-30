-- 0153_inbox_reality_app_grants.sql
--
-- Forward-fix: migration 0108 created inbox_reality_tests +
-- inbox_reality_test_results with RLS policies, but forgot to GRANT
-- SELECT/INSERT/UPDATE/DELETE to postwave_app. Runtime API calls
-- to /api/v1/inbox-reality/tests fail with
-- "permission denied for table inbox_reality_tests (SQLSTATE 42501)"
-- because the connection runs under the app role, not the admin role.
--
-- RLS already enforces tenant isolation; the missing GRANT was the
-- only thing blocking legitimate reads/writes.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_reality_tests TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_reality_test_results TO postwave_app;

COMMIT;
