-- 0369_sms_quiet_hours.sql
--
-- GAP-LS-145 (desktop audit 2026-06-10 item A7): make sms_quiet_hours
-- actually enforceable.
--
-- The table itself landed in 0253 with the Wave-3 scaffold shape
-- (per-country single window: country_code / start_local / end_local /
-- timezone / enabled) but nothing in the Go API ever read it — outbound
-- SMS was only gated by the legacy per-sender metadata quiet_hours
-- blob. This migration evolves the 0253 table into general labeled
-- windows the send gate evaluates:
--
--   * label        — operator-facing window name ("Weeknights", ...).
--   * days         — int[] day-of-week mask, 0=Sunday .. 6=Saturday,
--                    interpreted as the local day the window STARTS
--                    (an overnight 21:00->09:00 window with days={5}
--                    covers Fri 21:00 -> Sat 09:00).
--   * start_minute / end_minute — minute-of-day [0,1439], GENERATED
--                    from the existing start_local/end_local time
--                    columns so there is exactly one source of truth
--                    and pre-0369 rows keep working unchanged.
--
-- start_minute == end_minute means "all day" (matches the Go gate's
-- existing start==end semantics). start > end is an overnight window
-- crossing midnight. Enforcement: apps/api/internal/sms — Store.Gate
-- evaluates enabled windows in their IANA timezone and the worker
-- defers (requeues until window end) instead of permanently blocking.
--
-- RLS: 0253 already attached the canonical tenant policies; the DO
-- blocks below re-assert them so this migration is self-sufficient on
-- databases where 0253's CREATE TABLE IF NOT EXISTS was a no-op
-- against a hand-built table.

BEGIN;

ALTER TABLE sms_quiet_hours
    ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}';

-- country_code predates the labeled-window model; keep it for the
-- desktop scaffold but stop requiring callers to supply it.
ALTER TABLE sms_quiet_hours
    ALTER COLUMN country_code SET DEFAULT '';

-- Minute-of-day projections of the 0253 time columns. EXTRACT on a
-- `time` value is IMMUTABLE, so these can be STORED generated columns.
ALTER TABLE sms_quiet_hours
    ADD COLUMN IF NOT EXISTS start_minute int GENERATED ALWAYS AS
        ((EXTRACT(HOUR FROM start_local) * 60 + EXTRACT(MINUTE FROM start_local))::int) STORED,
    ADD COLUMN IF NOT EXISTS end_minute int GENERATED ALWAYS AS
        ((EXTRACT(HOUR FROM end_local) * 60 + EXTRACT(MINUTE FROM end_local))::int) STORED;

-- 0253 allowed exactly one window per (tenant, country). Labeled
-- windows need N rows per tenant, so drop that uniqueness.
ALTER TABLE sms_quiet_hours
    DROP CONSTRAINT IF EXISTS sms_quiet_hours_tenant_id_country_code_key;

CREATE INDEX IF NOT EXISTS sms_quiet_hours_tenant_enabled_idx
    ON sms_quiet_hours (tenant_id)
    WHERE enabled;

-- days must be a non-empty subset of 0..6 (0=Sunday).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'sms_quiet_hours'::regclass
           AND conname  = 'sms_quiet_hours_days_check'
    ) THEN
        ALTER TABLE sms_quiet_hours
            ADD CONSTRAINT sms_quiet_hours_days_check
            CHECK (cardinality(days) >= 1 AND days <@ ARRAY[0,1,2,3,4,5,6]);
    END IF;
END;
$$;

-- Re-assert the canonical tenant RLS policies (idempotent; normally
-- already present from 0253). GUC idiom: NULLIF(...)::uuid so an unset
-- app.tenant_id yields NULL instead of a cast error.
ALTER TABLE sms_quiet_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_quiet_hours FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_quiet_hours' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON sms_quiet_hours
            AS RESTRICTIVE FOR ALL
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_quiet_hours' AND policyname = 'tenant_visible'
    ) THEN
        CREATE POLICY tenant_visible ON sms_quiet_hours
            AS PERMISSIVE FOR ALL
            TO postwave_app
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END;
$$;

COMMIT;
