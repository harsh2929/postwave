-- 0206_klaviyo_predictive_foundation.sql
--
-- Klaviyo parity slice KLV-07: explainable profile predictions, RFM scores,
-- and model-run audit records on top of existing commerce/churn data.

BEGIN;

CREATE TABLE predictive_model_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    model_key       text NOT NULL,
    model_version   text NOT NULL DEFAULT 'heuristic-v1',
    status          text NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('queued','running','completed','failed')),
    input_window_days integer NOT NULL DEFAULT 365 CHECK (input_window_days > 0),
    scored_profiles integer NOT NULL DEFAULT 0,
    insufficient_profiles integer NOT NULL DEFAULT 0,
    metrics         jsonb NOT NULL DEFAULT '{}',
    error           text NOT NULL DEFAULT '',
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX predictive_model_runs_tenant_model_idx
    ON predictive_model_runs (tenant_id, model_key, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON predictive_model_runs TO postwave_app;

ALTER TABLE predictive_model_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictive_model_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON predictive_model_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON predictive_model_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE profile_predictions (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id              uuid,
    email                      citext NOT NULL,
    model_run_id               uuid REFERENCES predictive_model_runs(id) ON DELETE SET NULL,
    historic_clv_cents         integer NOT NULL DEFAULT 0,
    predicted_clv_cents        integer NOT NULL DEFAULT 0,
    total_clv_cents            integer NOT NULL DEFAULT 0,
    churn_risk                 numeric(6,5) NOT NULL DEFAULT 0,
    predicted_order_count      numeric(10,2) NOT NULL DEFAULT 0,
    average_days_between_orders numeric(10,2),
    expected_next_order_at     timestamptz,
    predicted_gender           text NOT NULL DEFAULT 'unknown'
                               CHECK (predicted_gender IN ('unknown','female','male','non_binary')),
    confidence                 numeric(6,5) NOT NULL DEFAULT 0,
    data_sufficiency           text NOT NULL DEFAULT 'insufficient'
                               CHECK (data_sufficiency IN ('insufficient','limited','sufficient')),
    explanation                jsonb NOT NULL DEFAULT '{}',
    calculated_at              timestamptz NOT NULL DEFAULT now(),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX profile_predictions_tenant_clv_idx
    ON profile_predictions (tenant_id, total_clv_cents DESC, calculated_at DESC);
CREATE INDEX profile_predictions_tenant_churn_idx
    ON profile_predictions (tenant_id, churn_risk DESC, calculated_at DESC);

CREATE TRIGGER profile_predictions_set_updated_at
    BEFORE UPDATE ON profile_predictions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_predictions TO postwave_app;

ALTER TABLE profile_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_predictions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profile_predictions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON profile_predictions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE profile_rfm_scores (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid,
    email              citext NOT NULL,
    model_run_id       uuid REFERENCES predictive_model_runs(id) ON DELETE SET NULL,
    recency_days       integer,
    frequency          integer NOT NULL DEFAULT 0,
    monetary_cents     integer NOT NULL DEFAULT 0,
    recency_score      smallint NOT NULL DEFAULT 1 CHECK (recency_score BETWEEN 1 AND 5),
    frequency_score    smallint NOT NULL DEFAULT 1 CHECK (frequency_score BETWEEN 1 AND 5),
    monetary_score     smallint NOT NULL DEFAULT 1 CHECK (monetary_score BETWEEN 1 AND 5),
    rfm_score          text NOT NULL DEFAULT '111',
    segment_key        text NOT NULL DEFAULT 'insufficient_data',
    calculated_at      timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX profile_rfm_scores_tenant_segment_idx
    ON profile_rfm_scores (tenant_id, segment_key, calculated_at DESC);

CREATE TRIGGER profile_rfm_scores_set_updated_at
    BEFORE UPDATE ON profile_rfm_scores
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_rfm_scores TO postwave_app;

ALTER TABLE profile_rfm_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_rfm_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profile_rfm_scores
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON profile_rfm_scores
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
