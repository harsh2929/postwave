-- 0256_lookalike_audiences.sql
--
-- GAP-LS-110 / GAP-LS-111 / GAP-LS-112: Custom-audience sync to
-- external ad networks (Meta, Google Ads, TikTok, LinkedIn, Snap).
-- This is the SCHEMA + sync-job ledger only — the actual provider
-- adapters land in apps/api/internal/destinations/ later. Per the
-- gap doc section 14, Postwave ships the export-to-ad-network
-- connectors rather than building lookalike modelling in-house.
--
-- TODO: each provider adapter (Meta Conversions API, Google Ads
-- OfflineUserDataJobService, TikTok Audience API, LinkedIn Audience
-- API, Snap Audience Match) needs OAuth + API-key handling that
-- this migration deliberately does NOT scaffold. Per agent rule 7,
-- the schema sits idle until a real adapter ships — no fake
-- credentials are written here.
--
-- audience_destinations is the per-tenant catalog of "where do we
-- sync this list/segment to" rows. status reflects the most recent
-- sync attempt; last_synced_at is the wall-clock of the last
-- successful run.
--
-- audience_sync_jobs is the per-run ledger. Members_synced is a
-- count for the dashboard; error captures the provider's last
-- failure string so an operator can self-diagnose without inbox
-- access to the ad account.

BEGIN;

CREATE TABLE IF NOT EXISTS audience_destinations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider              text NOT NULL CHECK (provider IN (
        'meta','google_ads','tiktok','linkedin','snap'
    )),
    list_id               uuid,
    segment_id            uuid,
    external_audience_id  text,
    status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN (
                              'draft','active','paused','syncing','error'
                          )),
    last_synced_at        timestamptz,
    config                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_destinations_tenant_provider_idx
    ON audience_destinations (tenant_id, provider, status);

CREATE INDEX IF NOT EXISTS audience_destinations_tenant_list_idx
    ON audience_destinations (tenant_id, list_id)
    WHERE list_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audience_destinations_tenant_segment_idx
    ON audience_destinations (tenant_id, segment_id)
    WHERE segment_id IS NOT NULL;

CREATE TRIGGER audience_destinations_set_updated_at
    BEFORE UPDATE ON audience_destinations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON audience_destinations TO postwave_app;

ALTER TABLE audience_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_destinations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audience_destinations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON audience_destinations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS audience_sync_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    destination_id  uuid NOT NULL REFERENCES audience_destinations(id) ON DELETE CASCADE,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed')),
    error           text NOT NULL DEFAULT '',
    members_synced  int NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_sync_jobs_destination_idx
    ON audience_sync_jobs (tenant_id, destination_id, started_at DESC);

CREATE INDEX IF NOT EXISTS audience_sync_jobs_tenant_status_idx
    ON audience_sync_jobs (tenant_id, status, started_at DESC);

GRANT SELECT, INSERT, UPDATE ON audience_sync_jobs TO postwave_app;

ALTER TABLE audience_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_sync_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audience_sync_jobs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON audience_sync_jobs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
