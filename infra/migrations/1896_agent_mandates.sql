-- 1896_agent_mandates.sql
--
-- A bounded grant for an agent, instead of the whole tenant.
--
-- The agent surface authenticates with a full tenant API key carrying
-- `ScopeMCP`. That key is not scoped to a task: it can reach every tool the
-- scope allows, on every resource in the tenant, for as long as the key lives.
-- An agent asked to "clean up bounced subscribers on the Spring list" holds the
-- same authority as one asked to delete everything, and nothing anywhere
-- records which task the authority was granted for.
--
-- A mandate is that missing sentence: THIS agent may perform THESE actions on
-- THESE resources, at most N times, until T. It is checked per call and spent
-- per call, so exceeding it is impossible rather than merely detectable.
--
-- WHY A COUNT AND NOT ONLY AN EXPIRY. Time bounds exposure; it does not bound
-- blast radius. An agent with a five-minute window can still delete every list
-- in that window. `uses_remaining` is what makes a mandate a budget rather than
-- a deadline, and it is decremented in the same statement that authorises,
-- because a read-then-decrement lets a parallel agent spend the last use twice.
--
-- WHY RESOURCES ARE A PREFIX SET, NOT ONE ID. Real tasks span a handful of
-- objects ("these three lists"), and a mandate per object would be minted in a
-- loop and defeat the point. A prefix is checked exactly, never by substring:
-- `list:42` must not authorise `list:420`.
--
-- Stores a HASH, like every other bearer credential here. The token exists only
-- in the agent's memory.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_mandates (
    id         uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Who granted it. A mandate always traces to a person: an agent cannot
    -- mint its own authority, which is the property that makes this governance
    -- rather than a second key format.
    granted_by uuid        NOT NULL,
    -- What the agent was asked to do, in the granter's words. Not decoration:
    -- it is what makes an audit answerable six months later, and it is the one
    -- field a reviewer reads first.
    purpose    text        NOT NULL,
    -- Named actions. Empty is not "all" — it is a mandate that authorises
    -- nothing, which is the safe reading of an unspecified grant.
    actions    text[]      NOT NULL DEFAULT '{}',
    -- Resource selectors like 'list:42' or 'campaign:*'. Same rule: empty
    -- authorises nothing.
    resources  text[]      NOT NULL DEFAULT '{}',
    token_hash bytea       NOT NULL,
    uses_remaining integer  NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    PRIMARY KEY (id),
    CONSTRAINT agent_mandates_purpose_len CHECK (char_length(purpose) BETWEEN 1 AND 500),
    CONSTRAINT agent_mandates_uses_nonneg CHECK (uses_remaining >= 0),
    CONSTRAINT agent_mandates_token_len CHECK (octet_length(token_hash) = 32)
);

COMMENT ON TABLE agent_mandates IS
    'A bounded grant: this agent may perform these actions on these resources, '
    'at most N times, until T, for this stated purpose. Checked and spent in one '
    'statement per call, so the budget cannot be exceeded by parallel agents.';

CREATE UNIQUE INDEX IF NOT EXISTS agent_mandates_token_idx
    ON agent_mandates (token_hash);

-- "What is this agent currently allowed to do" — the question an operator asks
-- when something unexpected happens.
CREATE INDEX IF NOT EXISTS agent_mandates_live_idx
    ON agent_mandates (tenant_id, expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE agent_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mandates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON agent_mandates;
CREATE POLICY tenant_isolation ON agent_mandates
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        -- Authorisation happens BEFORE a tenant is known: the mandate is what
        -- establishes it. Same resolver capability session lookup uses.
        OR current_setting('app.auth_resolver', true) = 'true'
        -- And the expiry sweep is cross-tenant. Named now rather than
        -- discovered later: this is the fifth table in one session where a
        -- missing worker capability made a sweep silently do nothing.
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.auth_resolver', true) = 'true'
        OR current_setting('app.outbox_worker', true) = 'true'
    );

DROP POLICY IF EXISTS tenant_visible ON agent_mandates;
CREATE POLICY tenant_visible ON agent_mandates
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_mandates TO postwave_app;

COMMIT;
