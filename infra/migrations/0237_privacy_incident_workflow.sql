-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0236_privacy_incident_workflow.sql — extends privacy_incidents
-- with the columns needed to drive the breach-response workflow
-- (clock_started_at, counsel sign-off pointers, template version,
-- jurisdictions_resolved) and adds three sibling tables:
--
--   incident_state_transitions  — append-only state-machine ledger
--   incident_notifications      — record of authority/customer/
--                                 data-subject packets that were sent
--   incident_tabletops          — auditable evidence of breach
--                                 tabletop drills (compliance reg req)
--
-- All tenant-scoped tables use the NULLIF current_setting RLS idiom
-- and are RESTRICTIVE + PERMISSIVE.

BEGIN;

-- ---------------------------------------------------------------------------
-- Extend privacy_incidents with workflow state columns
-- ---------------------------------------------------------------------------
ALTER TABLE privacy_incidents
    ADD COLUMN IF NOT EXISTS clock_started_at      timestamptz,
    ADD COLUMN IF NOT EXISTS discovered_at         timestamptz,
    ADD COLUMN IF NOT EXISTS counsel_signoff_at    timestamptz,
    ADD COLUMN IF NOT EXISTS signoff_by            text,
    ADD COLUMN IF NOT EXISTS template_version      text NOT NULL DEFAULT '2026-06',
    ADD COLUMN IF NOT EXISTS jurisdictions         text[] NOT NULL DEFAULT '{}'::text[];

-- ---------------------------------------------------------------------------
-- incident_state_transitions — append-only audit of state moves
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_state_transitions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    incident_id  uuid NOT NULL REFERENCES privacy_incidents(id) ON DELETE CASCADE,
    from_state   text NOT NULL,
    to_state     text NOT NULL,
    actor_email  text NOT NULL DEFAULT '',
    reason       text NOT NULL DEFAULT '',
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incident_state_transitions_incident_idx
    ON incident_state_transitions (incident_id, at DESC);
CREATE INDEX IF NOT EXISTS incident_state_transitions_tenant_idx
    ON incident_state_transitions (tenant_id, at DESC);

GRANT SELECT, INSERT ON incident_state_transitions TO postwave_app;

ALTER TABLE incident_state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_state_transitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON incident_state_transitions;
CREATE POLICY tenant_isolation ON incident_state_transitions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON incident_state_transitions;
CREATE POLICY tenant_visible ON incident_state_transitions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- incident_notifications — ledger of dispatched breach packets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_notifications (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    incident_id          uuid NOT NULL REFERENCES privacy_incidents(id) ON DELETE CASCADE,
    audience             text NOT NULL CHECK (audience IN ('authority', 'customer', 'data_subject')),
    template_key         text NOT NULL DEFAULT '',
    template_version     text NOT NULL DEFAULT '2026-06',
    rendered_body_sha256 text NOT NULL DEFAULT '',
    recipient_ref        text NOT NULL DEFAULT '',
    sent_at              timestamptz NOT NULL DEFAULT now(),
    sent_by              text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS incident_notifications_incident_idx
    ON incident_notifications (incident_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS incident_notifications_tenant_idx
    ON incident_notifications (tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS incident_notifications_audience_idx
    ON incident_notifications (incident_id, audience);

GRANT SELECT, INSERT ON incident_notifications TO postwave_app;

ALTER TABLE incident_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON incident_notifications;
CREATE POLICY tenant_isolation ON incident_notifications
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON incident_notifications;
CREATE POLICY tenant_visible ON incident_notifications
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- incident_tabletops — auditable artifact of breach-response drills
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_tabletops (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scenario       text NOT NULL DEFAULT '',
    ran_at         timestamptz NOT NULL DEFAULT now(),
    participants   jsonb NOT NULL DEFAULT '[]'::jsonb,
    findings       text NOT NULL DEFAULT '',
    evidence_path  text NOT NULL DEFAULT '',
    created_by     text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incident_tabletops_tenant_idx
    ON incident_tabletops (tenant_id, ran_at DESC);

GRANT SELECT, INSERT ON incident_tabletops TO postwave_app;

ALTER TABLE incident_tabletops ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_tabletops FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON incident_tabletops;
CREATE POLICY tenant_isolation ON incident_tabletops
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON incident_tabletops;
CREATE POLICY tenant_visible ON incident_tabletops
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
