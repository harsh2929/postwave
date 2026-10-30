-- 0047_campaign_digest_cursors.sql
--
-- Per-tenant cursor tracking for the opens/clicks digest cron.
--
-- The cron emits campaign.opens.digest + campaign.clicks.digest events
-- on an hourly cadence. To avoid double-counting events across ticks
-- (which would be an unrecoverable bug for any downstream system that
-- aggregates counters off the digest), we track a cursor: the
-- `last_at` timestamp from campaign_report_events that the previous
-- tick observed. The next tick queries `at > last_at` and updates
-- the cursor in the same tx as the digest emission.
--
-- One row per (tenant_id, campaign_id, event_kind) tuple — the kinds
-- we track are 'opened' and 'clicked'. If we add 'bounced' digests
-- later, no schema change required.
--
-- The cursor is sub-second precise (timestamptz). Two events with
-- the same `at` would normally be a problem, but campaign_report_events
-- has a serial PK we don't use here — using `at` keeps the cursor
-- query INDEX-friendly on the existing campaign_report_events_campaign_idx.
-- The corner-case "two events at the exact same microsecond on
-- different recipients" is acceptable to drop one event in V1 — opens
-- digests are statistical, not transactional.

BEGIN;

CREATE TABLE campaign_digest_cursors (
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    event_kind   text NOT NULL CHECK (event_kind IN ('opened', 'clicked')),
    last_at      timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, campaign_id, event_kind)
);

CREATE INDEX campaign_digest_cursors_tenant_idx
    ON campaign_digest_cursors (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_digest_cursors TO postwave_app;

ALTER TABLE campaign_digest_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_digest_cursors FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_digest_cursors
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy for the cross-tenant cron (same pattern as
-- outbox_events). The cron binds app.outbox_worker='true', SELECTs
-- across tenants, then re-binds app.tenant_id per row before UPDATE.
CREATE POLICY campaign_digest_cursors_worker_select ON campaign_digest_cursors
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_digest_cursors_worker_update ON campaign_digest_cursors
    AS PERMISSIVE
    FOR ALL
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
