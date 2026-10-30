-- 0097_auth_resolver_users_policy.sql
--
-- Native password login resolves email before it knows a tenant id. Migration
-- 0058 added resolver policies for auth_credentials/sessions/tokens, but the
-- first lookup still reads users. Without this policy a freshly created local
-- account can sign up successfully and then immediately get a uniform
-- invalid_credentials response because users RLS hides the row.

BEGIN;

DROP POLICY IF EXISTS users_auth_resolver_read ON users;

CREATE POLICY users_auth_resolver_read ON users
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.auth_resolver', true) = 'true');

COMMIT;
