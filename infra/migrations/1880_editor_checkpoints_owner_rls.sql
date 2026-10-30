-- 1880_editor_checkpoints_owner_rls.sql
--
-- Make "a checkpoint is one person's unsaved work" a database rule.
--
-- Migration 1878 isolated `editor_checkpoints` by TENANT and left the per-USER
-- half to a `AND user_id = $2::uuid` predicate in Go. An adversarial review
-- removed that predicate and every test in the package still passed — including
-- the one named for the guarantee, which survived on row order — so the only
-- thing separating two colleagues' half-written drafts was a line of SQL text
-- with nothing pinning it.
--
-- Tenant isolation being enforced by the database and user isolation being
-- enforced by convention is the wrong split for this table specifically: it is
-- the one continuity table that stores customer TEXT rather than an id
-- reference, so a forgotten predicate does not leak "which campaign Ada was
-- looking at", it leaks the subject line she was still drafting.
--
-- app.user_id is set by the same middleware that sets app.tenant_id. A policy
-- that reads it directly would slam shut on every job that does not set it, so
-- the rule is deliberately conditional: when the GUC is absent the policy falls
-- back to tenant scope alone, which is exactly the reach the sweeper and any
-- future admin tooling need. The protection is against a REQUEST-path query
-- forgetting the predicate, which is where the review broke it.

BEGIN;

DROP POLICY IF EXISTS owner_isolation ON editor_checkpoints;
CREATE POLICY owner_isolation ON editor_checkpoints
    AS RESTRICTIVE
    USING (
        NULLIF(current_setting('app.user_id', true), '') IS NULL
        OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(current_setting('app.user_id', true), '') IS NULL
        OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

COMMENT ON POLICY owner_isolation ON editor_checkpoints IS
    'Restricts a request that has established an acting user to that user''s own '
    'drafts, so a query missing its user_id predicate returns nothing rather '
    'than every colleague''s unfinished text. Falls through to tenant scope when '
    'app.user_id is unset, which is what the sweeper runs as.';

COMMIT;
