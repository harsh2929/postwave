-- 0083_web_vitals.sql
--
-- web_vitals_events: anonymous Core Web Vitals telemetry from the
-- public web app. Receives one row per metric (CLS, FID, LCP, INP,
-- TTFB) sampled by the browser and POSTed to /api/internal/web-vitals.
--
-- This table is GLOBAL (no RLS): visitors are anonymous so there is no
-- tenant id to scope by, and the data is purely operational telemetry.
-- We include `tenant_id` as a nullable column for the rare case where
-- the page already knows the tenant (e.g. a logged-in dashboard user)
-- but never enforce isolation on it. Aggregation queries should always
-- filter on (metric_name, at) which is what the index below targets.
--
-- We intentionally do NOT add a foreign key on tenant_id: the ingest
-- path is anonymous and we want a stale tenant id to be silently
-- recorded rather than rejected (drops fast under floods of bot
-- traffic). Same reasoning for not constraining metric_name to a
-- check-in: web-vitals.js can introduce new metrics (FCP, etc) faster
-- than we want to roll a migration.

BEGIN;

CREATE TABLE web_vitals_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       text,
    tenant_id        uuid,
    metric_name      text NOT NULL,
    value            numeric NOT NULL,
    rating           text,
    navigation_type  text,
    page_path        text,
    user_agent       text,
    at               timestamptz NOT NULL DEFAULT now()
);

-- Aggregation queries are almost always "p75 of metric X over the last
-- 24h"; pre-sort by (metric_name, at) so the rollup job can range-scan.
CREATE INDEX web_vitals_events_metric_at_idx
    ON web_vitals_events (metric_name, at DESC);

-- Secondary index for tenant-scoped rollups when a logged-in dashboard
-- user is the source. Cheap because most rows have tenant_id NULL.
CREATE INDEX web_vitals_events_tenant_at_idx
    ON web_vitals_events (tenant_id, at DESC)
    WHERE tenant_id IS NOT NULL;

-- No RLS: anonymous public ingest. The endpoint that writes to this
-- table runs with the postwave_app role but does NOT call
-- db.WithTenant, since the row is global telemetry. We deliberately
-- skip ENABLE ROW LEVEL SECURITY here so the postwave_app role can
-- INSERT/SELECT without an `app.tenant_id` GUC — and so a future
-- query like "p75 LCP across all tenants" works without bypassing RLS.

COMMIT;
