-- 0384_feed_sources.sql
--
-- FEATURE-ROADMAP-2026-06 "Recurring / RSS-to-email campaigns":
-- ingestion side. internal/newsletter_feed is feed OUTPUT
-- (archive -> RSS); this table is the INPUT registry — each row is one
-- RSS 2.0 / Atom feed the tenant wants turned into recurring draft
-- campaigns (apps/api/internal/feed_ingest).
--
-- Targeting mirrors how campaigns target audiences (campaigns
-- audience_list_id bigint + segment_id/audience_segment_id uuid,
-- migrations 0027 + 0068): list_id is the Listmonk bigint list id,
-- segment_id the Postwave segment uuid. Both nullable — a draft
-- campaign can be created without an audience and targeted later in
-- the composer, exactly like a hand-made draft.
--
-- template_id is a reserved reference to campaign_templates (0048) for
-- a future "render items through my template" mode; the v1 poller
-- renders a built-in digest body. Stored + echoed, not yet applied.
--
-- last_item_guid is the dedupe cursor: the poller only drafts items
-- that appear *before* this guid in the (newest-first) feed. The
-- poller never auto-sends — drafts only (see feed_ingest/poller.go).

BEGIN;

CREATE TABLE IF NOT EXISTS feed_sources (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    url              text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
    schedule         text NOT NULL DEFAULT 'manual'
                     CHECK (schedule IN ('manual','daily','weekly')),
    template_id      uuid,
    list_id          bigint,
    segment_id       uuid REFERENCES segments(id) ON DELETE SET NULL,
    subject_template text NOT NULL DEFAULT '{{title}}'
                     CHECK (length(subject_template) BETWEEN 1 AND 500),
    enabled          boolean NOT NULL DEFAULT true,
    last_polled_at   timestamptz,
    last_item_guid   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS feed_sources_tenant_idx
    ON feed_sources (tenant_id, created_at DESC);

-- Scheduler tick: "which enabled, scheduled sources are due?". Partial
-- so manual-only tenants cost nothing (mirrors audience_syncs_due_idx).
CREATE INDEX IF NOT EXISTS feed_sources_due_idx
    ON feed_sources (schedule, last_polled_at)
    WHERE enabled AND schedule <> 'manual';

CREATE TRIGGER feed_sources_set_updated_at
    BEFORE UPDATE ON feed_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON feed_sources TO postwave_app;

ALTER TABLE feed_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_sources FORCE ROW LEVEL SECURITY;

-- RESTRICTIVE gate, ANDed on top of every permissive policy (the 0325
-- external_warehouse_triggers lesson, applied up-front like 0383 did
-- retroactively). The read side admits worker scope so the permissive
-- worker-select policy below can actually fire; WITH CHECK stays
-- tenant-only, so worker scope without a bound tenant can read but
-- never insert/update feed sources.
CREATE POLICY tenant_isolation ON feed_sources
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive tenant policy for request paths (db.WithTenant).
CREATE POLICY tenant_visible ON feed_sources
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Scheduler enumeration (cross-tenant SELECT under db.WithWorkerScope,
-- mirroring audience_syncs_worker_select from 0376). The poller
-- re-binds app.tenant_id per row before fetching/drafting, so all
-- writes go through the tenant policies.
CREATE POLICY feed_sources_worker_select ON feed_sources
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
