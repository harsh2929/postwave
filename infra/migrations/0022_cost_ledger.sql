-- 0022_cost_ledger.sql
--
-- Append-only ledger of every billable unit of work the platform performs.
-- Cost is denominated in cents to dodge floating-point rounding. Records are
-- attributed to (tenant, api_key, actor_type, kind) so we can report agent
-- spend separately from human spend.

BEGIN;

CREATE TABLE cost_ledger (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    api_key_id  uuid,
    actor_type  text,
    kind        text        NOT NULL CHECK (kind IN
                    ('send', 'ai_generation', 'ai_diagnostic',
                     'rendering', 'storage', 'migration', 'other')),
    cents       int         NOT NULL,
    quantity    int         NOT NULL DEFAULT 1,
    at          timestamptz NOT NULL DEFAULT now(),
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX cost_ledger_tenant_at_idx
    ON cost_ledger (tenant_id, at DESC);
CREATE INDEX cost_ledger_tenant_kind_at_idx
    ON cost_ledger (tenant_id, kind, at DESC);
CREATE INDEX cost_ledger_tenant_apikey_at_idx
    ON cost_ledger (tenant_id, api_key_id, at DESC);

GRANT SELECT, INSERT ON cost_ledger TO postwave_app;
GRANT USAGE, SELECT  ON SEQUENCE cost_ledger_id_seq TO postwave_app;

ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cost_ledger
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
