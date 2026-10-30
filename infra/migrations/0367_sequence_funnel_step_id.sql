-- 0367_sequence_funnel_step_id.sql
--
-- A22 (desktop audit 2026-06-10): branch identity for sequence funnel
-- rows.
--
-- sequence_funnel_events keyed steps by a flat integer `position`,
-- which cannot distinguish branch steps: condition branches re-use
-- position numbering inside YesBranch/NoBranch (see
-- services/voice/internal/generation/types.go — a step's global id is
-- (parent-condition-id, branch, position)). The desktop sequence canvas
-- therefore hides funnel overlays on branch steps because two different
-- steps collapse into one funnel row.
--
-- This migration adds a nullable text `step_id` carrying the producer's
-- stable step identifier (recommended: "p<position>" for top-level
-- steps, "p<condPos>:yes:p<position>" / "p<condPos>:no:p<position>" for
-- branch steps; deeper nesting prepends further segments). Legacy rows
-- (and legacy producers) keep writing NULL and continue to behave
-- exactly as before.
--
-- Dedupe semantics: the old UNIQUE (tenant, sequence, subscriber,
-- position) cannot hold once branch rows arrive — a subscriber walking
-- yes-branch position 2 AND top-level position 2 is legal. We split the
-- constraint into two partial unique indexes:
--
--   * rows WITHOUT step_id keep the legacy position dedupe, so
--     existing producers' ON CONFLICT (…, position) style upserts keep
--     working (Postgres infers the partial index when the inserted row
--     matches its predicate);
--   * rows WITH step_id dedupe on the step id itself.
--
-- PRODUCER STATUS (verified against the repo, 2026-06-10): NO code in
-- THIS repository writes sequence_funnel_events. apps/api has no write
-- path; services/voice only READS the table (the participants
-- projection in services/voice/internal/storage/participants.go);
-- services/automation's runtime sends emails via Listmonk but has no
-- sequence/funnel concept and writes no funnel rows. The producers
-- named in migration 0052 ("automation runtime" / "voice sequence
-- dispatcher V2") — and the open/click updater — live OUTSIDE this
-- repo on the engine side. This migration is therefore the contract
-- those external producers must adopt; until they do, all rows keep
-- arriving with NULL step_id and behave exactly as before.
--
-- NOTE for those external producers: start sending step_id on insert
-- and target the new arbiter, e.g.
--
--   INSERT INTO sequence_funnel_events
--       (tenant_id, sequence_id, subscriber_email, position, step_id)
--   VALUES (...)
--   ON CONFLICT (tenant_id, sequence_id, subscriber_email, step_id)
--       WHERE step_id IS NOT NULL DO NOTHING;
--
-- step_id encoding (must match the desktop's
-- apps/desktop/src/components/sequence/funnel-metrics.ts exactly):
-- "p<position>" for top-level steps, "p<condPos>:yes:p<position>" /
-- "p<condPos>:no:p<position>" for branch steps; deeper nesting
-- prepends further segments (e.g. "p1:yes:p2:no:p1").
--
-- The analytics read side (apps/api/internal/analytics) groups by
-- (position, step_id) and emits step_id per funnel row, omitting it for
-- legacy NULL rows — fully backward compatible on the wire.

BEGIN;

ALTER TABLE sequence_funnel_events
    ADD COLUMN IF NOT EXISTS step_id text;

-- Drop the original UNIQUE (tenant_id, sequence_id, subscriber_email,
-- position) constraint by catalog lookup — its auto-generated name is
-- truncation-dependent, so we resolve it instead of hardcoding.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT con.conname INTO cname
      FROM pg_constraint con
     WHERE con.conrelid = 'sequence_funnel_events'::regclass
       AND con.contype = 'u';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sequence_funnel_events DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- Legacy producers (no step_id): identical dedupe semantics as before.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_funnel_events_legacy_dedupe
    ON sequence_funnel_events (tenant_id, sequence_id, subscriber_email, position)
    WHERE step_id IS NULL;

-- Step-aware producers: one row per subscriber per step.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_funnel_events_step_dedupe
    ON sequence_funnel_events (tenant_id, sequence_id, subscriber_email, step_id)
    WHERE step_id IS NOT NULL;

COMMIT;
