-- 0385_feed_source_runs.sql
--
-- Per-poll ledger for feed_sources (0384). One row per manual
-- "Poll now" / scheduler execution, mirroring audience_sync_runs
-- (0377). items_seen counts items parsed out of the feed document;
-- new_items counts those newer than the source's last_item_guid
-- cursor; campaign_id is the draft campaign created from that batch
-- (NULL when nothing was new or the poll failed). error captures the
-- first fetch/parse/draft failure verbatim so the operator can
-- self-diagnose (DNS, 4xx from the feed host, malformed XML, ...)
-- from the desktop runs drilldown.
--
-- status lifecycle: running -> succeeded | failed. The v1 poller is
-- synchronous-bounded, so a crash mid-poll can orphan a 'running' row;
-- clients should render those honestly with started_at.

BEGIN;

CREATE TABLE IF NOT EXISTS feed_source_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    feed_source_id uuid NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
    status         text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','succeeded','failed')),
    items_seen     integer NOT NULL DEFAULT 0,
    new_items      integer NOT NULL DEFAULT 0,
    campaign_id    uuid,
    error          text,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feed_source_runs_source_idx
    ON feed_source_runs (tenant_id, feed_source_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON feed_source_runs TO postwave_app;

ALTER TABLE feed_source_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_source_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON feed_source_runs
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
