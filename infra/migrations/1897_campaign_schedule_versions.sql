-- 1897_campaign_schedule_versions.sql
--
-- An auditable record of every schedule change.
--
-- `POST /api/v1/campaigns/{id}/schedule` writes `campaigns.scheduled_at` and
-- nothing else. The column holds the CURRENT intent and no history: who moved
-- the send, when, from what, and whether anything objected are all unrecoverable
-- the moment the value is overwritten.
--
-- That matters most in the case the endpoint exists for. A campaign moved out of
-- a send window, or moved after an approval was granted, is exactly the change
-- somebody asks about afterwards — and "the column says Tuesday" cannot answer
-- "who moved it off Monday, and did anyone warn them".
--
-- REFUSALS ARE RECORDED TOO. A blocked attempt is evidence: three refused
-- attempts to schedule outside a window is a person fighting a policy, which is
-- a conversation to have rather than a silence. A table that only holds
-- successes cannot show it.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_schedule_versions (
    id         bigserial   NOT NULL,
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid       NOT NULL,
    -- Who asked. Nullable because a scheduler or migration may move a send with
    -- no person behind it, and attributing that to somebody would be worse than
    -- leaving it blank.
    actor_user_id uuid,
    actor_label text       NOT NULL DEFAULT '',
    -- The transition. `from_at` is NULL for a first schedule, `to_at` is NULL
    -- for an unschedule — both are real, distinct events.
    from_at    timestamptz,
    to_at      timestamptz,
    outcome    text        NOT NULL,
    -- What objected, in words the person saw. Empty on a clean accept.
    reason     text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT campaign_schedule_versions_outcome_check
        CHECK (outcome = ANY (ARRAY['scheduled', 'unscheduled', 'warned', 'refused'])),
    CONSTRAINT campaign_schedule_versions_reason_len CHECK (char_length(reason) <= 1000)
);

COMMENT ON TABLE campaign_schedule_versions IS
    'Every attempt to change a campaign''s send time, including refused ones. '
    'campaigns.scheduled_at holds the current intent and no history; this is '
    'what answers "who moved it, from when, and did anything object".';

CREATE INDEX IF NOT EXISTS campaign_schedule_versions_campaign_idx
    ON campaign_schedule_versions (tenant_id, campaign_id, created_at DESC);

ALTER TABLE campaign_schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_schedule_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON campaign_schedule_versions;
CREATE POLICY tenant_isolation ON campaign_schedule_versions
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON campaign_schedule_versions;
CREATE POLICY tenant_visible ON campaign_schedule_versions
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON campaign_schedule_versions TO postwave_app;
GRANT USAGE ON SEQUENCE campaign_schedule_versions_id_seq TO postwave_app;

COMMIT;
