-- 0397_conversions_last_touch_attribution.sql
--
-- Close the "revenue attribution data flow" open loop.
--
-- Today a conversion is attributed to a campaign ONLY when the caller
-- explicitly supplies campaign_id (JSON body / ?c= / pw_campaign
-- cookie). Most real-world conversions arrive without it, so they land
-- in the "unattributed" bucket and per-campaign revenue/ROI is blind.
--
-- This migration enables AUTOMATIC last-touch attribution: at ingest
-- time (and via a one-shot backfill for historical rows) we join an
-- unattributed conversion to the subscriber's most recent in-window
-- email *click* recorded in campaign_report_events.
--
-- It adds two things:
--
--   1. conversions.attributed_via — honest provenance for HOW a
--      conversion's campaign_id was set. Nullable, no default:
--
--        'explicit'   — the caller passed campaign_id.
--        'last_touch' — auto-joined from a recent click (NEVER present
--                       this as certain — it is a heuristic).
--        'none'       — no campaign_id and no in-window click was found.
--        NULL         — pre-migration row not yet classified (the
--                       backfill endpoint stamps these; reads treat
--                       NULL like 'none'/'explicit' based on whether
--                       campaign_id is set — see attribution.go).
--
--      Nullable + no default is deliberate: a non-null default would
--      mislabel the millions of historical rows, and DROP-less, additive
--      column adds are the only rollback-safe option here.
--
--   2. A partial btree purpose-built for the last-touch lookup:
--      WHERE event_type = 'clicked' over (tenant_id, subscriber_email,
--      at DESC). The existing campaign_report_events_contact_idx
--      ((tenant_id, subscriber_email, at DESC), no event_type filter)
--      already serves the tenant/email/at access path, but the lookup
--      additionally filters event_type='clicked'; a partial index keeps
--      the scan tight on send/open-heavy event streams where clicks are
--      a small minority.
--
-- Partitioning note: campaign_report_events is RANGE-partitioned by `at`
-- (migration 0339). A plain CREATE INDEX on the partitioned PARENT
-- propagates to every child (current + future partitions inherit it),
-- which is exactly what we want. CREATE INDEX CONCURRENTLY is NOT
-- permitted on a partitioned parent, so we use the in-transaction
-- additive form below; it is fast on click-sparse partitions and the
-- partition rotator (apps/api/internal/partition_rotator) creates new
-- children with the inherited index automatically.
--
-- Attribution window: 7 days. The canonical value lives in
-- apps/api/internal/conversions/attribution.go
-- (lastTouchAttributionWindow); this comment documents it for operators
-- reading the schema. Out-of-window clicks NEVER attribute.

BEGIN;

-- 1. Provenance column. Additive + nullable + no default — historical
--    rows stay NULL until the backfill endpoint classifies them.
ALTER TABLE conversions
    ADD COLUMN IF NOT EXISTS attributed_via text;

-- Guard the allowed values without a non-null default (so legacy NULLs
-- remain valid). NOT VALID skips the full-table scan at apply time;
-- the only writers are this repo's ingest + backfill paths, which only
-- ever emit the three legal values, so existing rows already satisfy it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'conversions_attributed_via_check'
           AND conrelid = 'conversions'::regclass
    ) THEN
        ALTER TABLE conversions
            ADD CONSTRAINT conversions_attributed_via_check
            CHECK (attributed_via IN ('explicit', 'last_touch', 'none'))
            NOT VALID;
    END IF;
END $$;

-- 2. Last-touch lookup index on the partitioned parent (propagates to
--    all children). Partial on clicks — the only event_type the
--    last-touch join reads.
CREATE INDEX IF NOT EXISTS campaign_report_events_last_touch_idx
    ON campaign_report_events (tenant_id, subscriber_email, at DESC)
    WHERE event_type = 'clicked';

-- 3. The backfill endpoint UPDATEs historical rows (stamps
--    attributed_via + fills campaign_id). Migration 0049 granted the
--    runtime role only SELECT, INSERT on conversions; backfill needs
--    UPDATE. The tenant_isolation RLS policy (FOR ALL) still confines
--    every UPDATE to the acting tenant's own rows.
GRANT UPDATE ON conversions TO postwave_app;

COMMIT;
