-- 0112_blocklist_observations.sql
--
-- Durable per-IP / per-domain blocklist observations from the
-- continuous monitor. Each row records ONE check on ONE zone against
-- ONE subject (IP or domain) at ONE point in time.
--
-- Why a wide observation log rather than a "current state" table:
--   • Receivers don't care about your CURRENT listing status; they
--     care about your RECENT history. A 6-hour blip on a tier-1 list
--     drives more bounces than a stable listing on a tier-3 list.
--     The log lets the aggregator compute "hits per zone over the
--     last N hours" without forcing a "true state" abstraction the
--     receivers don't have.
--   • Auto-suppression decisions look at the latest observation per
--     (subject, zone) AND require N consecutive listed observations
--     before firing — both queries are trivial against the log
--     shape, awkward against a "current state" shape.
--
-- The continuous monitor (services/deliverability/internal/
-- reputation/blacklist/monitor.go) inserts one row per check. A
-- background process reads the latest-per-zone view to render the
-- dashboard's "IPs we monitor" surface.

BEGIN;

CREATE TABLE IF NOT EXISTS blocklist_observations (
  id                bigserial PRIMARY KEY,
  -- subject_type: 'ip' or 'domain'. Both share this table so a
  -- "list everything we observed about acme.com" query is one
  -- SELECT, not a UNION.
  subject_type      text        NOT NULL CHECK (subject_type IN ('ip', 'domain')),
  subject           text        NOT NULL,
  zone              text        NOT NULL,
  -- listed: true when the DNS lookup returned an A record, false
  -- when NXDOMAIN. Errors (DNS timeouts, refused) are surfaced via
  -- the `error` column and listed=false — we record the failure to
  -- detect monitor outages but don't count it as a hit.
  listed            boolean     NOT NULL,
  -- confidence is copied from the zone catalog at the time of the
  -- check. We store it on the row so a future re-weighting of the
  -- catalog doesn't retroactively change historical observations.
  confidence        numeric(3,2) NOT NULL DEFAULT 0.5
                      CHECK (confidence BETWEEN 0 AND 1),
  -- error is the textual DNS error returned by the monitor when
  -- the lookup couldn't complete. NULL on success.
  error             text,
  -- tenant_id is nullable because IPs in the free pool aren't
  -- tenant-scoped — they're operator-owned shared infra. Customer
  -- domains and dedicated IPs DO carry a tenant_id so the dashboard
  -- only shows your own observations.
  tenant_id         uuid,
  checked_at        timestamptz NOT NULL DEFAULT now()
);

-- Most queries are "latest N hours for one subject" → composite index
-- on the right side.
CREATE INDEX IF NOT EXISTS blocklist_observations_subject_idx
  ON blocklist_observations (subject_type, subject, checked_at DESC);

-- "Latest hit on this zone" lookups (auto-suppress decision).
CREATE INDEX IF NOT EXISTS blocklist_observations_subject_zone_idx
  ON blocklist_observations (subject_type, subject, zone, checked_at DESC);

-- "All hits in the last hour" (monitor health dashboard).
CREATE INDEX IF NOT EXISTS blocklist_observations_listed_recent_idx
  ON blocklist_observations (checked_at DESC)
  WHERE listed = true;

-- Tenant-scoped queries.
CREATE INDEX IF NOT EXISTS blocklist_observations_tenant_idx
  ON blocklist_observations (tenant_id, checked_at DESC)
  WHERE tenant_id IS NOT NULL;

-- RLS: rows with tenant_id are tenant-scoped; rows without tenant_id
-- (operator-owned free-pool IPs) are visible to admin queries only.
-- The runtime app role (postwave_app) sees only its own tenant's
-- rows. The deliverability monitor connects via a separate role with
-- privileged read so it can query ALL observations regardless of
-- tenant; that role is set up out of band (see ops/deliverability-
-- monitor-role.sql in the runbook).

ALTER TABLE blocklist_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocklist_observations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS blocklist_observations_tenant_isolation ON blocklist_observations;
CREATE POLICY blocklist_observations_tenant_isolation
  ON blocklist_observations
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Convenience view: latest observation per (subject, zone). The
-- monitor + dashboard both read this view to avoid repeating the
-- DISTINCT ON anti-pattern in every query.
CREATE OR REPLACE VIEW blocklist_observations_latest AS
SELECT DISTINCT ON (subject_type, subject, zone)
       subject_type, subject, zone, listed, confidence, error, tenant_id, checked_at
  FROM blocklist_observations
 ORDER BY subject_type, subject, zone, checked_at DESC;

COMMIT;
