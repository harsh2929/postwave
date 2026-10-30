-- 1941_experiment_identities.sql
--
-- One identity every variant system registers into.
--
-- Nine systems run experiments in this product and none of them records what an
-- experiment was FOR. Measured across the nine: hypothesis 0, owner 0, object
-- version 0, metric 2, stopping policy 1. Six months on, `winner_decided_at`
-- says which arm won and nothing about what was being asked — and a hypothesis
-- that was never written down cannot be recovered by any later schema.
--
-- A SIDECAR, not a migration. The row this closes says "one registry every
-- variant system REGISTERS INTO", and registration is what this is: each system
-- keeps its own store and writes one identity row keyed to its own record.
-- Rewriting nine live experiment schemas onto a shared identity is a multi-week
-- program with nine cutovers, and it would deliver the same fact this delivers
-- now — that somebody wrote down what the test was for.
--
-- system_key is NOT a free-text label. It must be one of the nine the registry
-- in internal/experiments knows, enforced at the boundary against
-- `experiments.Systems`, because an identity table accepting arbitrary keys
-- accumulates rows for systems nobody can find and reports coverage that is not
-- real.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS experiment_identities (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Which of the nine, and which row inside it. No FK: the nine live in
    -- different tables and a polymorphic FK is not expressible — the boundary
    -- validates the key against the registry instead, which is also where the
    -- list of nine actually lives.
    system_key    text NOT NULL,
    external_id   text NOT NULL,

    -- The six axes, each nullable because an experiment registered today may
    -- not know all of them yet, and refusing a partial identity would mean
    -- recording nothing rather than something.
    --
    -- HYPOTHESIS is the one that cannot be reconstructed later. A metric can be
    -- inferred from the data, an owner from the audit log; what somebody
    -- believed would happen exists only if they wrote it down.
    hypothesis    text,
    owner_user_id uuid,
    -- The version of the thing under test, so a result can be tied to the
    -- artefact that produced it rather than to whatever that artefact became.
    object_version text,
    metric_id      text,
    metric_version text,
    -- Stated BEFORE the result, which is the whole value: a stopping rule
    -- chosen after looking is not a stopping rule. Campaign A/B's unbounded
    -- peeking was measured declaring a false winner 37% of the time on two
    -- variants.
    stopping_policy text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, system_key, external_id)
);

CREATE INDEX IF NOT EXISTS experiment_identities_system_idx
    ON experiment_identities (tenant_id, system_key);

ALTER TABLE experiment_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_identities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON experiment_identities;
CREATE POLICY tenant_isolation ON experiment_identities
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON experiment_identities;
CREATE POLICY tenant_visible ON experiment_identities
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON experiment_identities TO postwave_app;

COMMENT ON TABLE experiment_identities IS
    'What an experiment was FOR — hypothesis, owner, object version, metric '
    'id+version, stopping policy — for any of the nine variant systems, keyed '
    'by (system_key, external_id). A sidecar so systems register rather than '
    'being rewritten.';

COMMIT;
