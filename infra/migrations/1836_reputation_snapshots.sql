-- 1836_reputation_snapshots.sql
--
-- INBOX-031 — persist tenant sending-reputation over time so the Inbox Reality
-- card can show a trend (SenderScore / per-provider buckets / blocklist-hit
-- count), not just a point-in-time snapshot. The deliverability service records
-- one row each time a tenant's reputation is fetched (capture-on-fetch), so the
-- series accrues as the dashboard is used and a later scheduled poller can add
-- rows without any schema change.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive; older versions never read it. Drop is safe once
-- no in-flight trend history matters.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS reputation_snapshots (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain              text NOT NULL DEFAULT '',
    ip                  text NOT NULL DEFAULT '',
    -- 0-100 SenderScore; -1 when the source was unavailable.
    sender_score        integer NOT NULL DEFAULT -1,
    -- low | medium | high | '' (unknown) per provider.
    google_score        text NOT NULL DEFAULT '',
    microsoft_score     text NOT NULL DEFAULT '',
    blacklist_hit_count integer NOT NULL DEFAULT 0,
    data_available      boolean NOT NULL DEFAULT false,
    checked_at          timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- One row per distinct measurement instant. Capture-on-fetch fires on
    -- every getReputation, but the aggregator freezes checked_at for the 24h
    -- cache TTL, so a cache hit re-presents the SAME checked_at. Deduping on
    -- (tenant, checked_at) collapses those repeat dashboard views into one row
    -- (Record INSERTs ON CONFLICT DO NOTHING), bounding growth to real fetches.
    UNIQUE (tenant_id, checked_at)
);

CREATE INDEX IF NOT EXISTS reputation_snapshots_tenant_time_idx
    ON reputation_snapshots (tenant_id, checked_at DESC);

GRANT SELECT, INSERT, DELETE ON reputation_snapshots TO postwave_app;

ALTER TABLE reputation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reputation_snapshots;
CREATE POLICY tenant_isolation ON reputation_snapshots
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
