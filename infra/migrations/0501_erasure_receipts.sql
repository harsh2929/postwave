-- 0501_erasure_receipts.sql
--
-- SUB-046 — Right-to-be-forgotten produces a machine-readable receipt.
--
-- Today the subscriber delete path (subscribers/repo.go Delete) writes an
-- erasure suppression (email_suppressions.metadata.gdpr_erasure=true) plus an
-- audit_log row (action="subscriber.deleted", email_redacted,
-- suppression_added=true). That is enough for an internal regulator trail, but
-- there is no dedicated, fetchable artifact a downstream DSAR tool — or the
-- data subject — can pull to PROVE the erasure happened. GDPR Article 17 and
-- the W3C DPV consent-27560 receipt pattern expect a machine-readable proof:
-- a stable receipt id, the erasure timestamp, and a non-reversible hash of the
-- erased address (never the cleartext PII, since the whole point is to forget
-- it).
--
-- This migration creates erasure_receipts, one row per erasure, capturing:
--   - subscriber_id:   the row that was erased (kept for cross-reference; the
--                      subscribers row itself is gone, so this is not an FK).
--   - email_redacted:  observability.RedactEmail output — a stable, non-
--                      reversible {hash}@{domain} token. NOT the cleartext.
--   - email_hash:      SHA-256 hex of the lowercased address — the canonical
--                      machine-readable proof token downstream tools match on.
--   - erased_at:       when the erasure was performed.
--   - metadata:        free-form jsonb (prev_status, source, audit pointers).
-- Indexed on (tenant_id, erased_at DESC) for the "recent erasures" read shape.
--
-- The receipt is written in the SAME tx as the subscriber delete + the
-- suppression insert, so an erasure can never be performed without its proof.
-- It deliberately does NOT store cleartext email: erasure means the address is
-- gone, and the receipt must remain compliant after the fact.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE erasure_receipts.

BEGIN;

CREATE TABLE IF NOT EXISTS erasure_receipts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The erased subscriber's id. Intentionally NOT a foreign key: the
    -- subscribers row is deleted in the same tx, so an FK would block the
    -- receipt write. Kept as a plain uuid for cross-reference with the
    -- audit_log row (which targets the same subscriber id).
    subscriber_id  uuid NOT NULL,
    -- Non-reversible {hash}@{domain} token (observability.RedactEmail). Safe to
    -- surface in a UI / hand to a downstream tool without re-exposing the PII
    -- the erasure was meant to remove.
    email_redacted text NOT NULL DEFAULT '',
    -- SHA-256 hex of the lowercased, trimmed cleartext address. The canonical
    -- machine-readable proof token: a downstream DSAR tool that holds the
    -- (now-erased) address can recompute this hash and match the receipt
    -- without Postwave ever storing the cleartext again.
    email_hash     text NOT NULL DEFAULT '',
    erased_at      timestamptz NOT NULL DEFAULT now(),
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE erasure_receipts IS
    'SUB-046 machine-readable right-to-be-forgotten receipts: one row per erasure with a non-reversible email hash + erasure timestamp, written in the same tx as the subscriber delete.';

-- "Recent erasures for this tenant" + the per-subscriber receipt fetch both
-- start from (tenant_id, erased_at DESC).
CREATE INDEX IF NOT EXISTS erasure_receipts_tenant_erased_at_idx
    ON erasure_receipts (tenant_id, erased_at DESC);

-- The GET /subscribers/{id}/erasure-receipt fetch resolves by subscriber_id.
CREATE INDEX IF NOT EXISTS erasure_receipts_subscriber_idx
    ON erasure_receipts (tenant_id, subscriber_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_receipts TO postwave_app;

ALTER TABLE erasure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_receipts FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON erasure_receipts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON erasure_receipts
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
