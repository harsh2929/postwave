-- 0409_segment_holdouts.sql
--
-- Segment P&L (feature #4, "Segment P&L"): per-segment holdout config
-- for HOLDOUT-VALIDATED causal lift. Mirrors campaign_holdouts but is
-- keyed on segment_id instead of campaign_id, so lift can be measured
-- against a *people cohort* (a segment) independent of any one campaign
-- send.
--
-- The seed + percent define a deterministic md5-hash bucket assignment
-- (0..99); the P&L computation re-scopes holdout.AssignBucket against a
-- segment's compiled membership exactly as the per-campaign lift surface
-- does, then compares control-vs-treated conversion rates. One holdout
-- per segment (PK on segment_id).
--
-- window_days bounds the lift measurement window. decided_at locks the
-- holdout in (the cohort population shifts if the segment AST changes
-- afterward — the UI surfaces a staleness warning when the segment was
-- updated after decided_at; this migration only stores the timestamp).
--
-- rollback-strategy: no-op — additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_holdouts (
    segment_id    uuid         NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    tenant_id     uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    percent       numeric(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 50),
    seed          text         NOT NULL,
    window_days   integer      NOT NULL DEFAULT 90 CHECK (window_days BETWEEN 1 AND 365),
    decided_at    timestamptz,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (segment_id)
);

CREATE INDEX IF NOT EXISTS segment_holdouts_tenant_idx
    ON segment_holdouts (tenant_id);

CREATE TRIGGER segment_holdouts_set_updated_at
    BEFORE UPDATE ON segment_holdouts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_holdouts TO postwave_app;

ALTER TABLE segment_holdouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_holdouts FORCE ROW LEVEL SECURITY;

-- RESTRICTIVE policy (deny-unless) — mirrors segment_size_history (0392).
CREATE POLICY tenant_isolation ON segment_holdouts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_holdouts
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
