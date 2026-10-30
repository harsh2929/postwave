-- 0323_inbound_email_intent.sql
--
-- G3 campaigns-2026 follow-up: durable intent classification for
-- replies threaded through inbound_emails. The list endpoint LEFT JOINs
-- this table so unclassified replies remain visible, and the manual
-- classifier route UPSERTs one row per inbound email.

BEGIN;

CREATE TABLE IF NOT EXISTS inbound_email_intent (
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inbound_email_id   bigint      NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    intent_class       text        NOT NULL
        CHECK (intent_class IN ('question','praise','unsub','ooo','other')),
    intent_confidence  numeric(4,3) NOT NULL DEFAULT 0,
    classifier         text        NOT NULL DEFAULT 'ai'
        CHECK (classifier IN ('ai','heuristic','manual')),
    classified_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, inbound_email_id)
);

CREATE INDEX IF NOT EXISTS inbound_email_intent_class_idx
    ON inbound_email_intent (tenant_id, intent_class, classified_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_email_intent TO postwave_app;

ALTER TABLE inbound_email_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_intent FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_email_intent
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON inbound_email_intent
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
