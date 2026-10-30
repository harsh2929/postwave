-- 1705_automation_re_enrollment.sql
--
-- Makes flow re-enrollment possible.
--
-- THE BUG THIS FIXES
-- ------------------
-- automation_executions was keyed on id = sha256(automation_id | email), so
-- exactly ONE row existed per (flow, subscriber) forever. Its completed_nodes
-- array was union-merged on every upsert and never cleared, and the engine
-- short-circuits on any node already in that set. A second trigger therefore
-- re-upserted current_node = entry, found entry already completed, acked
-- immediately, and the journey never ran.
--
-- Net effect: a subscriber could traverse any given flow exactly once, EVER.
-- Abandoned-cart, browse-abandonment, win-back, birthday, back-in-stock and
-- replenishment — every recurring flow a marketing platform exists to run —
-- fired at most once per person per lifetime. A customer who abandoned a cart
-- twice received one email.
--
-- THE FIX
-- -------
-- run_id scopes an execution to ONE traversal. execID() now hashes
-- (automation, subscriber, run), so each run gets its own row and therefore
-- its own clean completed_nodes set. No primary-key change is needed.
--
-- MIGRATION SAFETY
-- ----------------
-- Existing rows are backfilled to run_id = 'legacy', and execID() special-
-- cases that run to reproduce the OLD sha256(automation|email) id exactly.
-- A journey that is mid-flight when this deploys therefore keeps its primary
-- key and resumes normally rather than being orphaned.
--
-- BEHAVIOUR IS UNCHANGED ON DEPLOY. Re-enrollment is opt-in per flow
-- (automations.re_enrollment, default 'once'), because defaulting it to
-- 'always' would make every subscriber who has ever completed a flow eligible
-- again the instant this ships — mass-re-sending the entire back catalogue and
-- torching the sending domain.

-- 1. Scope executions to a run. NOT NULL with a default so the backfill is
--    atomic and no window exists where the column is null.
ALTER TABLE automation_executions
    ADD COLUMN IF NOT EXISTS run_id text NOT NULL DEFAULT 'legacy';

-- Look-ups are always (tenant, automation, subscriber) → latest run, which is
-- what Engine.Trigger asks for on EVERY trigger, so this index is hot.
--
-- CONCURRENTLY is mandatory: automation_executions is an existing, write-hot
-- table, and a plain CREATE INDEX takes an ACCESS EXCLUSIVE lock for the whole
-- build, blocking every writer. (scripts/lint-migrations.sh enforces this — it
-- exists because a non-concurrent index build already bit this project once in
-- production.) CONCURRENTLY cannot run inside a transaction, which is why this
-- file carries no BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS automation_executions_latest_run_idx
    ON automation_executions (tenant_id, automation_id, subscriber_email, started_at DESC);

COMMENT ON COLUMN automation_executions.run_id IS
    'One traversal of the flow. Rows predating re-enrollment carry ''legacy'', for which execID() reproduces the historical primary key so in-flight journeys survive the deploy.';

-- 2. The per-flow re-enrollment policy.
--    'once'     — default; a subscriber enters at most once (welcome series).
--    'always'   — a fresh run on every matching trigger (abandoned cart).
--    'cooldown' — a fresh run only if the previous one began more than
--                 re_enrollment_cooldown_hours ago (win-back, birthday).
--
-- BOTH tables need it: the runtime resolver reads a flow from `automations`
-- and falls back to `automation_journeys` (the flow-builder table), so a
-- column on only one of them would leave half the flows unable to express a
-- policy at all.
ALTER TABLE automations
    ADD COLUMN IF NOT EXISTS re_enrollment text NOT NULL DEFAULT 'once',
    ADD COLUMN IF NOT EXISTS re_enrollment_cooldown_hours integer NOT NULL DEFAULT 0;

ALTER TABLE automation_journeys
    ADD COLUMN IF NOT EXISTS re_enrollment text NOT NULL DEFAULT 'once',
    ADD COLUMN IF NOT EXISTS re_enrollment_cooldown_hours integer NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'automations_re_enrollment_check'
    ) THEN
        ALTER TABLE automations
            ADD CONSTRAINT automations_re_enrollment_check
            CHECK (re_enrollment IN ('once', 'always', 'cooldown'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'automation_journeys_re_enrollment_check'
    ) THEN
        ALTER TABLE automation_journeys
            ADD CONSTRAINT automation_journeys_re_enrollment_check
            CHECK (re_enrollment IN ('once', 'always', 'cooldown'));
    END IF;
END $$;

COMMENT ON COLUMN automations.re_enrollment IS
    'Whether a subscriber may re-enter this flow: once (default, preserves pre-1705 behaviour) | always | cooldown.';
COMMENT ON COLUMN automation_journeys.re_enrollment IS
    'Whether a subscriber may re-enter this flow: once (default, preserves pre-1705 behaviour) | always | cooldown.';
