-- 0189_inbound_route_matches.sql
--
-- Per-route match history for the inbound-route admin UI. The summary
-- columns (last_matched_at, match_count) on inbound_routes are great
-- for "is this rule alive?" but useless when debugging "why did this
-- email NOT fire the support rule I configured?". This table captures
-- one row per (route, inbound_email) pair so an operator can scroll
-- the recent firings of any single rule.
--
-- Schema decisions:
--   - inbound_email_id is a soft-FK by integer (matches inbound_emails.id
--     which is bigint serial). We don't add a hard FK constraint so a
--     retention purge of inbound_emails doesn't cascade into a noisy
--     route history. Old matches without a parent email show "(pruned)"
--     in the UI.
--   - tenant_id is denormalised onto the row so the RLS predicate is
--     a simple tenant_id = current setting, matching the rest of the
--     schema. (RLS is enabled per the global policy in migration 0001.)
--   - matched_at is its own column rather than reusing inbound_email
--     received_at — a rule may be re-evaluated against a stored email
--     during a preview/replay flow in the future, and the matched_at
--     timestamp is the event-time we care about for the timeline.
--
-- Retention: a separate scheduled job (TBD) will trim rows older than
-- 30 days. The matched_at index keeps that delete cheap.

CREATE TABLE IF NOT EXISTS inbound_route_matches (
  id               bigserial   PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  route_id         uuid        NOT NULL REFERENCES inbound_routes(id) ON DELETE CASCADE,
  inbound_email_id bigint      NULL,
  recipient        text        NOT NULL,
  subject          text        NOT NULL DEFAULT '',
  from_email       text        NOT NULL DEFAULT '',
  matched_at       timestamptz NOT NULL DEFAULT now()
);

-- Per-route, newest-first reads are the common access pattern (the UI
-- shows "last 50 matches for this rule").
CREATE INDEX IF NOT EXISTS inbound_route_matches_route_time_idx
  ON inbound_route_matches (route_id, matched_at DESC);

-- Tenant-wide reads support a hypothetical "all matches" view + the
-- retention job's WHERE matched_at < now() - INTERVAL '30 days' scan.
CREATE INDEX IF NOT EXISTS inbound_route_matches_tenant_time_idx
  ON inbound_route_matches (tenant_id, matched_at DESC);

-- RLS: tenant isolation. Mirrors the policy shape used elsewhere in
-- the schema — the API process sets app.tenant_id per request; the
-- outbox/maintenance workers set app.outbox_worker=true to bypass.
ALTER TABLE inbound_route_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbound_route_matches_tenant_isolation
  ON inbound_route_matches
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.outbox_worker', true) = 'true'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.outbox_worker', true) = 'true'
  );
