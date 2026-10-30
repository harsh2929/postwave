-- 0343_sto_ai_campaign_agent.sql
--
-- Phase 3 XL `sto-ai-campaign-agent` — schema for the LLM-driven
-- "Composer / Operator / Nova Agent" surface. Mirrors Klaviyo Composer,
-- Iterable Nova Agent (Apr 2026), MoEngage Merlin Custom Agents,
-- Braze Operator, and Customer.io AI Agent: a single prompt becomes a
-- fully-configured campaign plan (audience + content + timing +
-- branching) that the operator confirms before save.
--
-- Two tables:
--
--   ai_campaign_agent_sessions
--     The chat thread. One row per conversation between an operator and
--     the LLM. The session header carries tenant scope, status (the
--     confirm-before-save guardrail lives here — a `pending_confirmation`
--     session cannot create a campaign until the operator clicks Confirm),
--     and the most recent draft plan (denormalized to ai_campaign_plans
--     for queryability, but cached on the session for the live UI).
--
--   ai_campaign_agent_messages
--     Per-turn message log. Stores the operator prompt, the assistant
--     text reply, and the structured tool-call traces (list_segments,
--     list_templates, get_recent_campaign_performance, create_campaign_draft,
--     schedule_with_sto). Replayable for debugging + retraining datasets.
--
--   ai_campaign_plans
--     The proposed campaign config the LLM produced. One row per
--     accepted plan (the operator can preview many plans inside a
--     session; only the most recently confirmed one is materialized).
--     `campaign_id` is set when the operator confirms — that's the
--     guardrail.
--
-- All tables are tenant-scoped with the standard RLS GUC idiom + FORCE
-- ROW LEVEL SECURITY. Indexes cover the common reads: list sessions for
-- the desktop chat history sidebar, fetch messages by session ordered
-- by created_at, and look up the latest plan for a session.

BEGIN;

-- ---------------------------------------------------------------- sessions
CREATE TABLE IF NOT EXISTS ai_campaign_agent_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Optional: the user who opened the session. Nullable because some
    -- sessions may originate from API integrations rather than a seat.
    created_by_user uuid,
    -- Short title derived from the first prompt ("Black Friday teaser
    -- for power users"). Used in the chat history sidebar.
    title           text NOT NULL DEFAULT '',
    -- Lifecycle: 'open' (operator can keep chatting), 'pending_confirmation'
    -- (the LLM has produced a plan; the operator must click Confirm to
    -- materialize it as a campaign), 'confirmed' (a campaign was created),
    -- 'discarded' (operator killed the session).
    status          text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'pending_confirmation', 'confirmed', 'discarded')),
    -- The most recent draft plan rendered in the UI, denormalized for
    -- fast UI refresh. The authoritative copy lives in ai_campaign_plans.
    -- Free-form JSON: { name, subject, audience, schedule, branching, ... }.
    last_draft      jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Optional reference to the materialized campaign once the operator
    -- confirmed. NULL until confirm. ON DELETE SET NULL so deleting the
    -- campaign doesn't cascade and lose the chat history.
    campaign_id     uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_campaign_agent_sessions_tenant_updated
    ON ai_campaign_agent_sessions (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_campaign_agent_sessions_status
    ON ai_campaign_agent_sessions (tenant_id, status, updated_at DESC);

-- ---------------------------------------------------------------- messages
CREATE TABLE IF NOT EXISTS ai_campaign_agent_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id      uuid NOT NULL REFERENCES ai_campaign_agent_sessions(id) ON DELETE CASCADE,
    -- 'user' (operator prompt), 'assistant' (LLM text response), or
    -- 'tool' (synthesized log of a tool-call trace produced by the
    -- assistant — list_segments, create_campaign_draft, etc.).
    role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    -- The plaintext body of the message (user prompt, assistant reply,
    -- or a JSON-encoded tool trace). For 'tool', `tool_name` carries the
    -- canonical tool identifier and `tool_payload` is the structured
    -- output the tool returned to the LLM.
    body            text NOT NULL DEFAULT '',
    tool_name       text,
    tool_payload    jsonb,
    -- Token usage for cost accounting. Nullable because we may not have
    -- it for every turn (e.g., the initial empty session header).
    input_tokens    integer,
    output_tokens   integer,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_campaign_agent_messages_session
    ON ai_campaign_agent_messages (tenant_id, session_id, created_at);

-- ---------------------------------------------------------------- plans
CREATE TABLE IF NOT EXISTS ai_campaign_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id      uuid NOT NULL REFERENCES ai_campaign_agent_sessions(id) ON DELETE CASCADE,
    -- Plan version inside the session. Increments per LLM revision so
    -- the desktop can show "v3 of plan" in the diff view.
    plan_version    integer NOT NULL DEFAULT 1,
    -- The structured plan: { name, subject, preview_text, body_html,
    -- audience: { segment_ids, exclusion_segment_ids }, schedule:
    -- { mode: 'sto'|'absolute', send_at?: iso8601, sto_window? },
    -- branching?: [...] }. Validated by the handler before materialization.
    plan            jsonb NOT NULL,
    -- The campaign materialized from this plan, if any. NULL until the
    -- operator confirms; once set, it's the link the desktop follows to
    -- the campaign detail page after confirm.
    materialized_campaign_id uuid,
    -- The user who confirmed the plan (audit trail for the
    -- confirm-before-save guardrail).
    confirmed_by_user uuid,
    confirmed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_campaign_plans_session_version
    ON ai_campaign_plans (tenant_id, session_id, plan_version DESC);

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_campaign_agent_sessions TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_campaign_agent_messages TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_campaign_plans          TO postwave_app;

-- ---------------------------------------------------------------- RLS
ALTER TABLE ai_campaign_agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_campaign_agent_sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_campaign_agent_sessions_select ON ai_campaign_agent_sessions
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_sessions_insert ON ai_campaign_agent_sessions
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_sessions_update ON ai_campaign_agent_sessions
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_sessions_delete ON ai_campaign_agent_sessions
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE ai_campaign_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_campaign_agent_messages FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_campaign_agent_messages_select ON ai_campaign_agent_messages
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_messages_insert ON ai_campaign_agent_messages
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_messages_update ON ai_campaign_agent_messages
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_agent_messages_delete ON ai_campaign_agent_messages
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE ai_campaign_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_campaign_plans FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_campaign_plans_select ON ai_campaign_plans
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_plans_insert ON ai_campaign_plans
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_plans_update ON ai_campaign_plans
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY ai_campaign_plans_delete ON ai_campaign_plans
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
