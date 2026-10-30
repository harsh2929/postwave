-- 0202_klaviyo_flow_builder_foundation.sql
--
-- Klaviyo parity slice KLV-03: productize the existing automation runtime into
-- a visual flow-builder contract with node/action catalogs, graph versions,
-- activity ledgers, transactional approvals, A/B tests, and backfill jobs.

BEGIN;

-- Older automation tables were created with only restrictive policies. Add
-- permissive companions so tenant-scoped dashboard/API reads work under FORCE
-- RLS without weakening the tenant guard.
DROP POLICY IF EXISTS tenant_visible ON automations;
CREATE POLICY tenant_visible ON automations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON automation_executions;
CREATE POLICY tenant_visible ON automation_executions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON automation_paused;
CREATE POLICY tenant_visible ON automation_paused
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON automation_journeys;
CREATE POLICY tenant_visible ON automation_journeys
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON automation_journey_executions;
CREATE POLICY tenant_visible ON automation_journey_executions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON automation_journey_events;
CREATE POLICY tenant_visible ON automation_journey_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_flow_node_registry (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key             text NOT NULL,
    label           text NOT NULL,
    category        text NOT NULL
                    CHECK (category IN ('trigger','wait','message','split','action','goal','control')),
    channel         text NOT NULL DEFAULT ''
                    CHECK (channel IN ('','email','sms','push','webhook','profile','list','commerce')),
    runtime_status  text NOT NULL DEFAULT 'supported'
                    CHECK (runtime_status IN ('supported','partial','planned','unsupported')),
    requires_approval boolean NOT NULL DEFAULT false,
    definition      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX automation_flow_node_registry_tenant_category_idx
    ON automation_flow_node_registry (tenant_id, category, runtime_status, key);

CREATE TRIGGER automation_flow_node_registry_set_updated_at
    BEFORE UPDATE ON automation_flow_node_registry
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_flow_node_registry TO postwave_app;

ALTER TABLE automation_flow_node_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_flow_node_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_flow_node_registry
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_flow_node_registry
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_flow_action_registry (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key             text NOT NULL,
    label           text NOT NULL,
    category        text NOT NULL
                    CHECK (category IN ('profile','list','tag','consent','webhook','commerce','support','system')),
    runtime_status  text NOT NULL DEFAULT 'supported'
                    CHECK (runtime_status IN ('supported','partial','planned','unsupported')),
    definition      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX automation_flow_action_registry_tenant_category_idx
    ON automation_flow_action_registry (tenant_id, category, runtime_status, key);

CREATE TRIGGER automation_flow_action_registry_set_updated_at
    BEFORE UPDATE ON automation_flow_action_registry
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_flow_action_registry TO postwave_app;

ALTER TABLE automation_flow_action_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_flow_action_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_flow_action_registry
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_flow_action_registry
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_flow_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id   uuid,
    journey_id      uuid,
    version         integer NOT NULL DEFAULT 1,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived','reverted')),
    graph           jsonb NOT NULL DEFAULT '{}',
    generated_by    text NOT NULL DEFAULT 'human'
                    CHECK (generated_by IN ('human','ai','migration','template')),
    source_ref      text NOT NULL DEFAULT '',
    published_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, automation_id, version),
    UNIQUE (tenant_id, journey_id, version),
    CHECK (automation_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE INDEX automation_flow_versions_recent_idx
    ON automation_flow_versions (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_flow_versions TO postwave_app;

ALTER TABLE automation_flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_flow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_flow_versions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_flow_versions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_message_approvals (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id          uuid,
    journey_id             uuid,
    node_id                text NOT NULL,
    channel                text NOT NULL DEFAULT 'email'
                           CHECK (channel IN ('email','sms','push','webhook')),
    message_ref            text NOT NULL DEFAULT '',
    transactional_status   text NOT NULL DEFAULT 'marketing'
                           CHECK (transactional_status IN ('marketing','requested','approved','rejected','revoked')),
    approval_id            uuid,
    evidence               jsonb NOT NULL DEFAULT '{}',
    requested_at           timestamptz,
    decided_at             timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CHECK (automation_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE UNIQUE INDEX automation_message_approvals_node_idx
    ON automation_message_approvals (
        tenant_id,
        COALESCE(automation_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(journey_id, '00000000-0000-0000-0000-000000000000'::uuid),
        node_id
    );

CREATE TRIGGER automation_message_approvals_set_updated_at
    BEFORE UPDATE ON automation_message_approvals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_message_approvals TO postwave_app;

ALTER TABLE automation_message_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_message_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_message_approvals
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_message_approvals
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_flow_ab_tests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id  uuid,
    journey_id     uuid,
    node_id        text NOT NULL,
    status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','running','completed','paused','archived')),
    variants       jsonb NOT NULL DEFAULT '[]',
    winner         jsonb NOT NULL DEFAULT '{}',
    started_at     timestamptz,
    ended_at       timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (automation_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE INDEX automation_flow_ab_tests_tenant_idx
    ON automation_flow_ab_tests (tenant_id, status, updated_at DESC);

CREATE TRIGGER automation_flow_ab_tests_set_updated_at
    BEFORE UPDATE ON automation_flow_ab_tests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_flow_ab_tests TO postwave_app;

ALTER TABLE automation_flow_ab_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_flow_ab_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_flow_ab_tests
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_flow_ab_tests
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_flow_activity (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id     uuid,
    journey_id        uuid,
    node_id           text NOT NULL DEFAULT '',
    subscriber_email  citext,
    event_type        text NOT NULL
                      CHECK (event_type IN ('entered','waiting','sent','skipped','review_pending','review_approved','converted','failed','exited')),
    status            text NOT NULL DEFAULT '',
    payload           jsonb NOT NULL DEFAULT '{}',
    at                timestamptz NOT NULL DEFAULT now(),
    CHECK (automation_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE INDEX automation_flow_activity_node_idx
    ON automation_flow_activity (tenant_id, automation_id, journey_id, node_id, at DESC);
CREATE INDEX automation_flow_activity_subscriber_idx
    ON automation_flow_activity (tenant_id, subscriber_email, at DESC)
    WHERE subscriber_email IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON automation_flow_activity TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE automation_flow_activity_id_seq TO postwave_app;

ALTER TABLE automation_flow_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_flow_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_flow_activity
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_flow_activity
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE automation_backfill_jobs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id     uuid,
    journey_id        uuid,
    source_type       text NOT NULL
                      CHECK (source_type IN ('list','segment','event','manual')),
    source_ref        text NOT NULL DEFAULT '',
    reentry_policy    text NOT NULL DEFAULT 'once'
                      CHECK (reentry_policy IN ('once','after_exit','after_delay','always')),
    delay_seconds     integer NOT NULL DEFAULT 0,
    status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','failed','cancelled')),
    counters          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    finished_at       timestamptz,
    CHECK (automation_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE INDEX automation_backfill_jobs_tenant_status_idx
    ON automation_backfill_jobs (tenant_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_backfill_jobs TO postwave_app;

ALTER TABLE automation_backfill_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_backfill_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_backfill_jobs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON automation_backfill_jobs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
