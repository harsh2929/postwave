-- 0215_dashboard_anomalies.sql
--
-- Refined Dashboard PR 3: persists detected anomalies so the
-- "Recent anomalies" card on /dashboard can show a history rather
-- than only the most recently computed spike. Also feeds desktop
-- notifications — the page diffs the latest row against
-- previously-seen ids to decide whether to fire a toast.
--
-- One row per (tenant, metric, day_bucket) — we only need to know
-- "did metric X spike on day Y" once; subsequent recomputes during
-- the day update the existing row.

BEGIN;

CREATE TABLE dashboard_anomalies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    metric      text NOT NULL,           -- 'bounces' | 'opens' | 'clicks' | 'subscribers'
    day_bucket  date NOT NULL,           -- the day the spike was detected (UTC)
    value       int NOT NULL,            -- observed count on day_bucket
    mean        double precision NOT NULL, -- trailing-window mean used for the z-score
    z_score     double precision NOT NULL, -- value's z-score against the trailing window
    range_used  text NOT NULL,           -- '7d' | '30d' | '90d' used for detection
    detected_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, metric, day_bucket)
);

CREATE INDEX dashboard_anomalies_tenant_detected_idx
    ON dashboard_anomalies (tenant_id, detected_at DESC);

ALTER TABLE dashboard_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_anomalies FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dashboard_anomalies
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_anomalies TO postwave_app;

COMMIT;
