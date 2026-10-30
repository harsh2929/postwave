-- 0326_send_time_archive_p3_followups.sql
--
-- Remaining Send-Time + Archive 2026 P3 backbones:
--   - optimized trigger-delay preferences
--   - intelligent retry event queue
--   - campaign content-optimizer run state
--   - subscriber delivered event vocabulary

BEGIN;

ALTER TABLE subscriber_events
    DROP CONSTRAINT IF EXISTS subscriber_events_event_type_check;

ALTER TABLE subscriber_events
    ADD CONSTRAINT subscriber_events_event_type_check
    CHECK (event_type IN (
        'opened','clicked','delivered','bounced','complained','unsubscribed','replied',
        'custom','identified','merged','suppressed','status_changed',
        'consent_changed','lifecycle_stage_changed'
    ));

CREATE TABLE IF NOT EXISTS trigger_delay_preferences (
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id         uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    event_name            text NOT NULL,
    optimal_delay_seconds integer NOT NULL DEFAULT 0
                          CHECK (optimal_delay_seconds >= 0 AND optimal_delay_seconds <= 2592000),
    sample_count          integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    confidence            numeric(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    reason                text,
    computed_at           timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id, event_name)
);

CREATE INDEX IF NOT EXISTS trigger_delay_preferences_event_idx
    ON trigger_delay_preferences (tenant_id, event_name, computed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON trigger_delay_preferences TO postwave_app;

ALTER TABLE trigger_delay_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_delay_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON trigger_delay_preferences
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON trigger_delay_preferences
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS intelligent_retry_events (
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    reason           text NOT NULL DEFAULT 'frequency_cap',
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','ready','retrying','retried','dismissed','failed')),
    retry_after      timestamptz NOT NULL DEFAULT now(),
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    breakdown        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, campaign_id, subscriber_email, reason)
);

CREATE INDEX IF NOT EXISTS intelligent_retry_events_due_idx
    ON intelligent_retry_events (tenant_id, status, retry_after);

CREATE INDEX IF NOT EXISTS intelligent_retry_events_campaign_idx
    ON intelligent_retry_events (tenant_id, campaign_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON intelligent_retry_events TO postwave_app;

ALTER TABLE intelligent_retry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligent_retry_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON intelligent_retry_events
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY tenant_visible ON intelligent_retry_events
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS campaign_content_optimizer_runs (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','active','paused','completed','archived')),
    config      jsonb NOT NULL DEFAULT '{}'::jsonb,
    preview     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_content_optimizer_runs_campaign_idx
    ON campaign_content_optimizer_runs (tenant_id, campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS campaign_content_optimizer_runs_active_idx
    ON campaign_content_optimizer_runs (tenant_id, status, updated_at DESC)
    WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_content_optimizer_runs TO postwave_app;

ALTER TABLE campaign_content_optimizer_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_content_optimizer_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_content_optimizer_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_content_optimizer_runs
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
