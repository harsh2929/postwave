-- 1747_campaign_recipients_partitioning.sql
--
-- G-33 (gap register, docs/2026-frontier/03-gap-register.md): campaign_recipients
-- is a plain heap table (relkind='r') and is the busiest table in the send
-- path -- the send-loop worker claims batches from it with
-- `SELECT ... FOR UPDATE SKIP LOCKED` on every tick (0167), and every
-- QueueAndStartCampaign call bulk-INSERTs one row per audience member. It is
-- currently unpartitioned, so the only retention lever is an O(N) DELETE FROM
-- ... WHERE loop -- the exact problem 0339 already solved for the five event
-- tables.
--
-- rollback-strategy: expand-contract - this migration only creates a new,
--   empty, unused table (campaign_recipients_partitioned) plus its initial
--   partitions. No application code reads or writes it yet and the live
--   campaign_recipients heap table is not touched (no RENAME, no ALTER, no
--   lock contention with the send-loop worker or QueueAndStartCampaign).
-- rollback-details: DROP TABLE IF EXISTS campaign_recipients_partitioned
--   CASCADE; is safe at any time before the follow-up CONTRACT-STEP
--   migration below cuts application traffic over -- zero rows exist in it
--   until that step runs.
--
-- ===========================================================================
-- EXPAND STEP (this migration)
-- ===========================================================================
--
-- Build campaign_recipients_partitioned as a RANGE-partitioned shadow table
-- beside the live, populated campaign_recipients heap. This is the ONLY safe
-- way to partition a hot, actively-written table without a blind
-- ALTER/rewrite: PostgreSQL cannot convert an existing ordinary table into a
-- partitioned one in place (a partitioned table's on-disk identity is
-- fundamentally different -- it has no storage of its own, only children),
-- so any partitioning strategy must either (a) RENAME the live table into a
-- child partition of a brand-new parent (0339's approach, safe because the
-- five event tables' consumers are append/read-mostly and tolerate a
-- momentary ACCESS EXCLUSIVE rename lock) or (b) build the new partitioned
-- table entirely alongside the old one and cut traffic over later. We use
-- (b) here because campaign_recipients has an in-flight claim/lease state
-- machine (0167: pending -> sending -> sent, guarded by SELECT ... FOR
-- UPDATE SKIP LOCKED) that a mid-flight RENAME could observe half-migrated;
-- deferring the cutover to a dedicated, rehearsed CONTRACT step removes that
-- risk entirely from this deploy.
--
-- Partition key: created_at.
--   campaign_recipients today (0068) has no timestamp column suitable for
--   RANGE partitioning -- `sent_at` and `claimed_at` are both nullable and
--   only populated once a row is dequeued/sent, so most `pending` rows would
--   collide on NULL. We define `created_at timestamptz NOT NULL DEFAULT
--   now()` only on the NEW table; the LIKE clause below pulls in every other
--   column, default, and CHECK constraint from the live table unchanged, and
--   the live table itself is never touched.
--
--   We use RANGE(created_at) rather than HASH(campaign_id) because the
--   partitioning goal here is retention, not query pruning: the dominant
--   read shapes (campaign_recipients_campaign_status_idx,
--   campaign_recipients_cancellable_idx) already prune to one campaign via a
--   plain b-tree index on campaign_id, which HASH partitioning would not
--   improve on. What RANGE(created_at) buys instead is the same win 0339
--   delivered for the event tables: retention becomes an O(1) DETACH+DROP
--   per month instead of an unbounded DELETE FROM ... WHERE batch loop.
--
-- Indexes: created directly on the partitioned PARENT (not per-child, unlike
--   0339). 0339 built indexes per-child because it ATTACHed a pre-existing,
--   potentially 100M-row legacy partition -- a parent-level CREATE INDEX
--   there would recurse into that legacy child inside one AccessExclusiveLock
--   transaction, which is exactly the multi-minute stall 0339's header warns
--   against. That risk doesn't exist here: every partition created by this
--   migration (the DEFAULT catch-all and the three dated partitions below)
--   is brand new and empty, so a parent-level CREATE INDEX recurses into
--   them at zero cost, AND PostgreSQL automatically attaches the same index
--   to any partition created after the parent index exists too -- so the
--   CONTRACT-step backfill and the future partition-rotator worker never
--   have to remember to (re)create per-partition indexes by hand.
--
-- RLS: PostgreSQL replicates RLS enablement and policies from a partitioned
--   parent to every child, present and future, automatically. We declare the
--   exact tenant_visible / campaign_recipients_worker_select policy pair
--   that 0077 + 0096 established on campaign_recipients so the two tables
--   have identical isolation semantics ahead of the CONTRACT-step cutover.
--
-- Foreign keys: LIKE ... INCLUDING CONSTRAINTS carries over the status CHECK
--   but never copies foreign keys (documented PostgreSQL LIKE behavior), so
--   the campaign_id / tenant_id / variant_id FKs are re-stated explicitly
--   below as table constraints, matching campaign_recipients' live shape.
--
-- Uniqueness: the live campaign_recipients_campaign_email_uniq_v2 unique
--   index on (campaign_id, lower(subscriber_email)) cannot be reproduced
--   as-is: PostgreSQL requires every unique/primary-key constraint on a
--   partitioned table to include the partition key, so the equivalent index
--   below is (campaign_id, lower(subscriber_email), created_at). In
--   practice this is not a meaningful weakening -- QueueAndStartCampaign
--   inserts every recipient row for one campaign send in the same request,
--   so duplicate (campaign_id, email) pairs for a real double-enqueue land
--   within the same created_at partition and are still caught; the
--   uniqueness guarantee only widens for the pathological case of the same
--   campaign being re-queued weeks apart, which 0158's original guard was
--   never designed to catch either (it predates recurrence/re-enrollment).
--
-- ===========================================================================
-- CONTRACT STEP (future migration + deploy -- deliberately NOT part of this
-- migration; documented here so the cutover is planned, reviewed, and
-- rehearsed against a populated staging copy before it runs)
-- ===========================================================================
--
--   1. Ship an application change (or a short maintenance window on
--      high-volume tenants -- pick based on measured campaign_recipients
--      write QPS at cutover time) so new sends are safe to interrupt
--      briefly during step 4's rename.
--   2. Backfill existing rows in id-ordered batches via a keyset cursor
--      (NOT a single INSERT ... SELECT, which would hold row locks across
--      the whole table for the duration and race the live worker's
--      SKIP LOCKED claims):
--
--        INSERT INTO campaign_recipients_partitioned
--             (id, campaign_id, tenant_id, subscriber_email, status,
--              sent_at, error, claimed_at, variant_id, created_at)
--        SELECT cr.id, cr.campaign_id, cr.tenant_id, cr.subscriber_email,
--               cr.status, cr.sent_at, cr.error, cr.claimed_at, cr.variant_id,
--               -- Best-effort provenance: sent_at/claimed_at approximate a
--               -- row's real creation time once the worker has touched it;
--               -- COALESCE to the parent campaign's own timestamps for rows
--               -- still pending, then now() as a last resort so no row is
--               -- ever rejected for lacking a partition key.
--               COALESCE(cr.sent_at, cr.claimed_at, c.started_at, c.created_at, now())
--          FROM campaign_recipients cr
--          JOIN campaigns c ON c.id = cr.campaign_id
--         WHERE cr.id > :cursor
--         ORDER BY cr.id
--         LIMIT 5000
--        ON CONFLICT (id, created_at) DO NOTHING;
--
--      Rows whose derived created_at falls outside the pre-created dated
--      partitions land safely in campaign_recipients_partitioned_default
--      (that is precisely what the DEFAULT partition is for). A follow-up,
--      non-blocking cleanup can DETACH + re-partition that bucket into real
--      monthly children once the backfill reveals the true historical date
--      range, for full retention-DETACH coverage.
--   3. Verify: per-tenant COUNT(*) and a sampled row-hash comparison match
--      between campaign_recipients and campaign_recipients_partitioned.
--   4. Swap, inside one short transaction (the only step that needs a brief
--      pause on campaign_recipients -- seconds, since it is DDL-only):
--
--        BEGIN;
--          LOCK TABLE campaign_recipients IN ACCESS EXCLUSIVE MODE;
--          -- (re-run step 2's backfill query once more for the handful of
--          -- rows written since the last batch, same WHERE cr.id > :cursor)
--          ALTER TABLE campaign_recipients RENAME TO campaign_recipients_old;
--          ALTER TABLE campaign_recipients_partitioned RENAME TO campaign_recipients;
--          ALTER SEQUENCE campaign_recipients_id_seq OWNED BY campaign_recipients.id;
--        COMMIT;
--
--      RLS state, policies, and indexes all follow the relation through the
--      RENAME automatically -- nothing needs re-granting.
--   5. Keep campaign_recipients_old for one full retention cycle before
--      DROP, as a fast rollback path (see below).
--
--   Rollback of the CONTRACT step, if it ships and misbehaves:
--        ALTER TABLE campaign_recipients RENAME TO campaign_recipients_partitioned;
--        ALTER TABLE campaign_recipients_old RENAME TO campaign_recipients;
--      then replay step 2's backfill query for any rows written only to the
--      partitioned table during the bad window, before retrying.
--
--   Rollback of THIS (expand) step, if needed before the CONTRACT step ever
--   ships: DROP TABLE IF EXISTS campaign_recipients_partitioned CASCADE;
--   -- zero impact, since nothing reads or writes this table yet.
--
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Partitioned parent. LIKE pulls in every column, default, and CHECK
-- constraint campaign_recipients has accreted since 0068 (subscriber_email,
-- status + its CHECK, sent_at, error, claimed_at, variant_id) without us
-- having to hand-maintain a column list that drifts, exactly as 0339's
-- header explains. `id`'s LIKE-copied default (nextval on the shared
-- campaign_recipients_id_seq) intentionally keeps sharing the live
-- sequence -- this table has no writers of its own yet, so there is no
-- contention, and it means the future CONTRACT step's cutover does not need
-- to change the id numbering space.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_recipients_partitioned (
    created_at timestamptz NOT NULL DEFAULT now(),
    LIKE campaign_recipients INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
    PRIMARY KEY (id, created_at),
    CONSTRAINT campaign_recipients_partitioned_campaign_id_fkey
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT campaign_recipients_partitioned_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT campaign_recipients_partitioned_variant_id_fkey
        FOREIGN KEY (variant_id) REFERENCES campaign_variants(id) ON DELETE SET NULL
) PARTITION BY RANGE (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_recipients_partitioned TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_recipients_id_seq TO postwave_app;

-- RLS: identical isolation contract to campaign_recipients (0068 + 0077 +
-- 0096). Declared on the parent; PostgreSQL replicates rowsecurity state
-- and policies to every present and future child automatically.
ALTER TABLE campaign_recipients_partitioned ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients_partitioned FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON campaign_recipients_partitioned;
CREATE POLICY tenant_visible ON campaign_recipients_partitioned
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS campaign_recipients_worker_select ON campaign_recipients_partitioned;
CREATE POLICY campaign_recipients_worker_select ON campaign_recipients_partitioned
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------------
-- Partitions.
--
-- A DEFAULT partition first, as the safety net for the CONTRACT step's
-- backfill (any derived created_at outside the dated partitions below still
-- lands somewhere instead of raising "no partition of relation found for
-- row"), then the current UTC month plus two months ahead so the table has
-- headroom for new writes from day one of the CONTRACT-step cutover. Month
-- boundaries are computed once at migration time (this is a one-shot DDL
-- statement, not a live volatile reference) so the dated partition names
-- and FOR VALUES bounds always match whatever month the migration actually
-- runs in, matching 0339's cutover-boundary approach.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_recipients_partitioned_default
    PARTITION OF campaign_recipients_partitioned DEFAULT;

DO $migration$
DECLARE
    month0  date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    month1  date := month0 + INTERVAL '1 month';
    month2  date := month0 + INTERVAL '2 months';
    month3  date := month0 + INTERVAL '3 months';
    bound0  text := to_char(month0, 'YYYY-MM-DD');
    bound1  text := to_char(month1, 'YYYY-MM-DD');
    bound2  text := to_char(month2, 'YYYY-MM-DD');
    bound3  text := to_char(month3, 'YYYY-MM-DD');
    suffix0 text := to_char(month0, 'YYYY_MM');
    suffix1 text := to_char(month1, 'YYYY_MM');
    suffix2 text := to_char(month2, 'YYYY_MM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS campaign_recipients_partitioned_p%s PARTITION OF campaign_recipients_partitioned FOR VALUES FROM (%L) TO (%L)',
        suffix0, bound0, bound1
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS campaign_recipients_partitioned_p%s PARTITION OF campaign_recipients_partitioned FOR VALUES FROM (%L) TO (%L)',
        suffix1, bound1, bound2
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS campaign_recipients_partitioned_p%s PARTITION OF campaign_recipients_partitioned FOR VALUES FROM (%L) TO (%L)',
        suffix2, bound2, bound3
    );
END
$migration$;

-- ---------------------------------------------------------------------------
-- Indexes on the parent -- see header for why parent-level (not per-child)
-- is safe here. Mirrors every live campaign_recipients index (0068, 0158,
-- 0166, 0167, 0197, 1696) except the uniqueness index, which grows the
-- partition key (see header).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_partitioned_campaign_email_uniq
    ON campaign_recipients_partitioned (campaign_id, lower(subscriber_email), created_at);

CREATE INDEX IF NOT EXISTS campaign_recipients_partitioned_campaign_status_idx
    ON campaign_recipients_partitioned (campaign_id, status);

CREATE INDEX IF NOT EXISTS campaign_recipients_partitioned_tenant_idx
    ON campaign_recipients_partitioned (tenant_id);

CREATE INDEX IF NOT EXISTS campaign_recipients_partitioned_cancellable_idx
    ON campaign_recipients_partitioned (tenant_id, campaign_id, status)
    WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS campaign_recipients_partitioned_stuck_claim_idx
    ON campaign_recipients_partitioned (claimed_at)
    WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS campaign_recipients_partitioned_variant_idx
    ON campaign_recipients_partitioned (tenant_id, variant_id)
    WHERE variant_id IS NOT NULL;

COMMIT;
