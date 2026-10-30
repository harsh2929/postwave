-- 0537_dsar_store_responses.sql
--
-- SUB-053 — DSAR fan-out automation across stores (per-store response log).
--
-- Why this migration:
--   When a SAR is created with fan-out enabled, the orchestrator
--   (apps/api/internal/sar/dsar_fanout.go) enumerates the tenant's connected
--   commerce stores (commerce_integrations), searches each provider for the
--   subject by email, applies the dsar_policies decision (migration 0536), and
--   either exports or deletes the store's copy. Each provider interaction must
--   leave a durable, auditable artifact proving WHAT happened per store — the
--   compliance receipt a regulator asks for.
--
--   This migration creates dsar_store_responses: one row per (SAR request,
--   provider) capturing the outcome — whether a matching customer was found,
--   the action taken (returned vs deleted vs skipped vs ack_required), the
--   provider's customer id, a receipt URL (webhook receipt / API response
--   location), and the raw provider response payload for the audit trail.
--
--   request_id references sar_bundles(id): the rows are read back by
--   GET /api/v1/sar/requests/{id}/store-responses so an auditor can see the
--   per-store DSAR status without re-running the fan-out.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE dsar_store_responses.

BEGIN;

CREATE TABLE IF NOT EXISTS dsar_store_responses (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The SAR this fan-out belongs to. ON DELETE CASCADE so purging a SAR
    -- bundle also removes its per-store receipts.
    request_id       uuid NOT NULL REFERENCES sar_bundles(id) ON DELETE CASCADE,
    provider         text NOT NULL CHECK (provider IN (
                         'shopify', 'woocommerce', 'stripe', 'square'
                     )),
    -- The provider-side customer identifier matched for the subject (empty
    -- when no matching customer was found).
    customer_id      text NOT NULL DEFAULT '',
    -- Outcome of the per-store interaction.
    --   found        -> matching customer located, no destructive action
    --   returned     -> data exported into the SAR bundle (return_only policy)
    --   deleted      -> provider erasure/anonymise issued (auto_delete policy)
    --   ack_required -> destructive policy held pending operator ack
    --   not_found    -> no matching customer at this provider
    --   error        -> provider call failed (see response_payload.error)
    status           text NOT NULL DEFAULT 'not_found' CHECK (status IN (
                         'found', 'returned', 'deleted', 'ack_required',
                         'not_found', 'error'
                     )),
    -- Compliance receipt pointer: a webhook receipt URL or the API response
    -- location proving the deletion/retention decision. Empty when none.
    receipt_url      text NOT NULL DEFAULT '',
    -- Raw provider response (or {"error": "..."} on failure) for the audit
    -- trail. Never trusted for control flow — purely evidentiary.
    response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dsar_store_responses IS
    'SUB-053 per-store DSAR fan-out receipts: one row per (sar request, provider) proving the return/delete/ack outcome.';

-- "All store responses for SAR request X" — the dominant read shape
-- (GET /api/v1/sar/requests/{id}/store-responses).
CREATE INDEX IF NOT EXISTS dsar_store_responses_request_idx
    ON dsar_store_responses (tenant_id, request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON dsar_store_responses TO postwave_app;

ALTER TABLE dsar_store_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_store_responses FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dsar_store_responses
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON dsar_store_responses
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
