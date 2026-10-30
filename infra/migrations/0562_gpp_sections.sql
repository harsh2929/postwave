-- 0562_gpp_sections.sql
--
-- SUB-120-GPP-ingest-emit — IAB Global Privacy Platform (GPP) section storage.
--
-- Why this migration:
--   Postwave already records consent state (consent_receipts 0140, the per-
--   purpose consent vector 0318, subscriber_tracking_prefs 0235), but it has no
--   place to store the raw IAB GPP string a Consent Management Platform (CMP)
--   emits per jurisdiction (us-national, California, EU TCF, ...). Downstream
--   ad-platform syncs increasingly expect the GPP string passed through
--   verbatim. This migration adds:
--
--     - subscribers.gpp_sections jsonb: a per-jurisdiction map of the latest
--       GPP section strings, e.g. {"usnat":"BAAAAAA...","usca":"BAAAAAA..."}.
--       Default '{}'. Stored as-is — no parsing/decoding here (that is a future
--       compliance phase). Mirrors the per-recipient jsonb shape used by
--       subscriber_tracking_prefs (migration 0235).
--
--     - subscriber_gpp_audit: a tenant-scoped append-only ledger of every GPP
--       section change (ingest from a CMP webhook, or a manual admin override),
--       so an auditor can reconstruct who set which jurisdiction's section when.
--
-- rollback-strategy: additive. Hard rollback = DROP COLUMN subscribers.gpp_sections
--   + DROP TABLE subscriber_gpp_audit.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS gpp_sections jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN subscribers.gpp_sections IS
    'SUB-120 per-jurisdiction IAB GPP section strings, stored verbatim. {} = none on file.';

CREATE TABLE IF NOT EXISTS subscriber_gpp_audit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- The GPP jurisdiction key whose section changed (e.g. 'usnat','usca','tcfeuv2').
    jurisdiction    text NOT NULL,
    -- The GPP section string written for that jurisdiction (verbatim).
    section_value   text NOT NULL,
    -- Where the change came from. Pinned via CHECK so a drifting client cannot
    -- land an unknown provenance.
    source          text NOT NULL DEFAULT 'cmp_webhook' CHECK (source IN (
                        'cmp_webhook', 'manual_override', 'import', 'api'
                    )),
    created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE subscriber_gpp_audit IS
    'SUB-120 append-only audit of per-jurisdiction GPP section changes (CMP ingest + manual overrides).';

-- "All GPP changes for subscriber X, newest first" — the audit-trail read shape.
CREATE INDEX IF NOT EXISTS subscriber_gpp_audit_subscriber_idx
    ON subscriber_gpp_audit (tenant_id, subscriber_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_gpp_audit TO postwave_app;

ALTER TABLE subscriber_gpp_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_gpp_audit FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_gpp_audit
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_gpp_audit
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
