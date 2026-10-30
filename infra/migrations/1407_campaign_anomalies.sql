-- 1407_campaign_anomalies.sql
--
-- G18 follow-up: persist per-campaign hourly anomalies so the live SSE
-- feed + history endpoint serve durable detections instead of recomputing
-- statelessly each call. Keyed (tenant, campaign, metric, hour_bucket)
-- so a re-detection of the same hour upserts rather than duplicating.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_anomalies (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    metric      text        NOT NULL,            -- opens|clicks|unsubs
    hour_bucket timestamptz NOT NULL,
    value       integer     NOT NULL,
    mean        double precision NOT NULL,
    z_score     double precision NOT NULL,
    direction   text        NOT NULL,            -- spike|drop
    detected_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, campaign_id, metric, hour_bucket)
);

CREATE INDEX IF NOT EXISTS campaign_anomalies_lookup_idx
    ON campaign_anomalies (tenant_id, campaign_id, detected_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_anomalies TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_anomalies_id_seq TO postwave_app;

ALTER TABLE campaign_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_anomalies FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_anomalies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON campaign_anomalies
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
