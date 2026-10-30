-- KLV-14: persisted untracked-link reporting.
--
-- ScanUntrackedLinks lints campaign HTML for links that bypass click tracking,
-- but the only sink was a single overwritable jsonb blob on
-- click_tracking_policies (last_untracked_report). There was no per-campaign
-- history queryable by operators. This table records one report per campaign,
-- populated from the send pipeline at body-fetch time.

BEGIN;

CREATE TABLE click_tracking_untracked_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     uuid,
    scanned_at      timestamptz NOT NULL DEFAULT now(),
    total_links     integer NOT NULL DEFAULT 0 CHECK (total_links >= 0),
    tracked_links   integer NOT NULL DEFAULT 0 CHECK (tracked_links >= 0),
    untracked_links integer NOT NULL DEFAULT 0 CHECK (untracked_links >= 0),
    findings        jsonb NOT NULL DEFAULT '[]',
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One report per (tenant, campaign). A NULL campaign_id (ad-hoc scan
    -- persisted via the API) is allowed to repeat — Postgres treats NULLs as
    -- distinct in a UNIQUE index.
    UNIQUE (tenant_id, campaign_id)
);

CREATE INDEX click_tracking_untracked_reports_tenant_idx
    ON click_tracking_untracked_reports (tenant_id, scanned_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON click_tracking_untracked_reports TO postwave_app;

ALTER TABLE click_tracking_untracked_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE click_tracking_untracked_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON click_tracking_untracked_reports
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON click_tracking_untracked_reports
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
