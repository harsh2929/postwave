-- 0114_dedicated_ip_assignments.sql
--
-- Per-tenant dedicated IP assignments + pool reputation snapshots.
--
-- The existing sending_state.dedicated_ip column stores one IP per
-- tenant for the legacy single-IP Pro tier. Reputation-tier customers
-- need 2-4 IPs per pool with reputation tracking + auto-rotation.
-- This table is the many-to-many extension; reads in the dispatcher
-- consult this table first (when present), falling back to
-- sending_state.dedicated_ip if no rows exist.
--
-- Two tables here:
--   1. dedicated_ip_assignments — which IPs belong to which tenant +
--      pool, with status (active / draining / retired).
--   2. ip_reputation_snapshots — per-IP rolled-up reputation refreshed
--      by the snapshot worker. Keeps a 7-day history so the dashboard
--      can show "your IP health over time".

BEGIN;

-- --------------------------------------------------------------------
-- dedicated_ip_assignments
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dedicated_ip_assignments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    ip            text NOT NULL,
    pool          text NOT NULL DEFAULT 'paid_pro'
                      CHECK (pool IN ('paid_standard','paid_pro','paid_reputation','byo')),
    -- status='active' is the steady state; 'draining' means a halt
    -- decision was made and the dispatcher is bleeding new traffic
    -- away; 'retired' means fully drained + safe to delete.
    status        text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','draining','retired')),
    -- halted_reason is set when status flips to draining. Common
    -- values: 'blocklist_tier1', 'engagement_critical', 'manual'.
    halted_reason text,
    halted_at     timestamptz,
    -- warmup_started_at tracks per-IP warmup state (separate from
    -- the tenant-wide sending_state.warmup_started_at because each
    -- IP has its own ramp).
    warmup_started_at timestamptz,
    -- provisioning metadata
    provider           text NOT NULL DEFAULT 'postmark'
                           CHECK (provider IN ('postmark','sendgrid','ses','byo')),
    provider_resource_id text,  -- e.g. Postmark "dedicated IP id"
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, ip)
);

CREATE INDEX IF NOT EXISTS idx_dedicated_ip_assignments_tenant
    ON dedicated_ip_assignments (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dedicated_ip_assignments_ip
    ON dedicated_ip_assignments (ip);

GRANT SELECT, INSERT, UPDATE, DELETE ON dedicated_ip_assignments TO postwave_app;

ALTER TABLE dedicated_ip_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON dedicated_ip_assignments AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The dispatcher + snapshot worker read across tenants.
CREATE POLICY dedicated_ip_assignments_worker_select ON dedicated_ip_assignments
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY dedicated_ip_assignments_worker_update ON dedicated_ip_assignments
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- --------------------------------------------------------------------
-- ip_reputation_snapshots — per-IP rolled-up health timeline
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_reputation_snapshots (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ip                text NOT NULL,
    tenant_id         uuid,  -- NULL for free-pool IPs
    pool              text NOT NULL,
    blocklist_hits    int  NOT NULL DEFAULT 0,
    bounce_rate_7d    numeric(6,4) NOT NULL DEFAULT 0,
    complaint_rate_7d numeric(6,4) NOT NULL DEFAULT 0,
    sender_score      int NOT NULL DEFAULT 0,
    halted            boolean NOT NULL DEFAULT false,
    health            int NOT NULL DEFAULT 100  -- 0-100 from AggregatePool
                          CHECK (health BETWEEN 0 AND 100),
    sampled_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_reputation_snapshots_ip
    ON ip_reputation_snapshots (ip, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_snapshots_tenant
    ON ip_reputation_snapshots (tenant_id, sampled_at DESC)
    WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON ip_reputation_snapshots TO postwave_app;

ALTER TABLE ip_reputation_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON ip_reputation_snapshots AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY ip_reputation_snapshots_worker_all ON ip_reputation_snapshots
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
