-- 0150_campaign_replies_grants.sql
--
-- Forward-fix: migration 0087 created campaign_replies with an RLS
-- policy that names postwave_app but never granted the role
-- SELECT/INSERT/UPDATE/DELETE on the table. The role hits the
-- table-level permission check before RLS evaluates, so every
-- query returns "permission denied for table campaign_replies".
--
-- Symptom this fixes: /api/v1/replies/summary (and any other read
-- endpoint over campaign_replies) returning 500 with a downstream
-- "current transaction is aborted" error when a second query in
-- the same tx is attempted after the first one swallowed the
-- permission denial.
--
-- We grant the four DML rights the rest of the codebase already
-- holds for analogous tables; RLS still gates which rows are
-- visible.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_replies TO postwave_app;

COMMIT;
