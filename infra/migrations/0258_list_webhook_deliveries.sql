-- 0258_list_webhook_deliveries.sql
--
-- GAP-LS-129: per-attempt delivery log for list-event webhooks. Today
-- the list_webhooks (0225) endpoint stores the subscription but
-- there is no UI for "did the webhook actually arrive at the
-- consumer's endpoint?" — operators have to scrape app logs to
-- triage. This table is the ledger the UI renders.
--
-- Append-only by design. Retention is handled by the retention
-- sweep package (0233 export_retention pattern) once a policy is
-- wired — schema only here.

BEGIN;

CREATE TABLE IF NOT EXISTS list_webhook_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_id      uuid NOT NULL,
    list_id         uuid,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_status int,
    response_body   text NOT NULL DEFAULT '',
    attempted_at    timestamptz NOT NULL DEFAULT now(),
    succeeded_at    timestamptz,
    error           text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS list_webhook_deliveries_lookup_idx
    ON list_webhook_deliveries (tenant_id, webhook_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS list_webhook_deliveries_tenant_list_idx
    ON list_webhook_deliveries (tenant_id, list_id, attempted_at DESC)
    WHERE list_id IS NOT NULL;

-- Triage helper: "show me failed deliveries in the last 24h"
CREATE INDEX IF NOT EXISTS list_webhook_deliveries_failed_idx
    ON list_webhook_deliveries (tenant_id, attempted_at DESC)
    WHERE succeeded_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON list_webhook_deliveries TO postwave_app;

ALTER TABLE list_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_webhook_deliveries
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_webhook_deliveries
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
