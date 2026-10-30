-- 0266_ai_explainability_records.sql
--
-- SUB-058-070: LLM profile-summary explainability log + 24h cache.
--
-- Each call to /api/v1/subscribers/{id}/ai-summary writes one row to
-- ai_explainability_records — the GDPR Article 86 "right to
-- explanation" audit trail (prompt hash, model, drivers, response).
-- A 24h cache table keys on (tenant_id, subscriber_id, content_hash)
-- so unchanged signals skip the LLM round trip.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_explainability_records (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid        NOT NULL,
    surface         text        NOT NULL DEFAULT 'subscriber_summary',
    model           text        NOT NULL DEFAULT '',
    prompt_hash     text        NOT NULL,
    response        text        NOT NULL DEFAULT '',
    drivers         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- "ai" when synthesized by the voice service, "deterministic" when
    -- assembled from structured signals only (provider unavailable).
    source          text        NOT NULL DEFAULT 'deterministic',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_explainability_records_tenant_idx
    ON ai_explainability_records (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_explainability_records_subscriber_idx
    ON ai_explainability_records (tenant_id, subscriber_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON ai_explainability_records TO postwave_app;

ALTER TABLE ai_explainability_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_explainability_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_explainability_records
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON ai_explainability_records
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 24h cache. (tenant_id, subscriber_id, content_hash) is the natural
-- key — same signals on the same subject get a cache hit.
CREATE TABLE IF NOT EXISTS ai_profile_summary_cache (
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid        NOT NULL,
    content_hash    text        NOT NULL,
    summary         text        NOT NULL DEFAULT '',
    drivers         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    source          text        NOT NULL DEFAULT 'deterministic',
    last_updated    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    PRIMARY KEY (tenant_id, subscriber_id, content_hash)
);

CREATE INDEX IF NOT EXISTS ai_profile_summary_cache_expires_idx
    ON ai_profile_summary_cache (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_profile_summary_cache TO postwave_app;

ALTER TABLE ai_profile_summary_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_profile_summary_cache FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_profile_summary_cache
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON ai_profile_summary_cache
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
