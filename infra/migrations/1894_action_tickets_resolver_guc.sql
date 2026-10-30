-- 1894_action_tickets_resolver_guc.sql
--
-- Fix the resolver capability name on action_tickets.
--
-- Migration 1893's policy admitted `app.session_resolver`. No such GUC exists:
-- the auth layer's pre-tenant path sets `app.auth_resolver` (and
-- `app.tenant_resolver`), which is what `Repo.withResolverGUC` binds and what
-- every other pre-tenant policy in this schema reads.
--
-- The failure would have been silent and total. A ticket arrives with no tenant
-- context by design, so the RESTRICTIVE policy would have evaluated `tenant_id =
-- NULL OR <a GUC nobody sets> = 'true'` — false — and every redemption would
-- have reported "no such ticket". Indistinguishable from an expired link, and
-- the fix would have been looked for in the ticket logic rather than in a
-- capability name that was invented rather than checked.
--
-- Caught by reading `withResolverGUC` instead of assuming its name. The general
-- lesson is the one this ledger keeps recording: a capability referenced by a
-- string is only a contract if something verifies the string.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON action_tickets;
CREATE POLICY tenant_isolation ON action_tickets
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.auth_resolver', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.auth_resolver', true) = 'true'
    );

COMMIT;
