-- 0550_subscriber_pii_findings.sql
--
-- SUB-071 — Shadow-PII discovery via AI scan (findings table).
--
-- Why this migration:
--   Custom fields can carry a declared PIIFlag (FieldConfig.pii_flag, 0415),
--   but free-text values frequently smuggle in *undeclared* PII — an SSN typed
--   into a "notes" field, a credit-card number in "comment", a passport number
--   in "id". A DPO needs continuous discovery of these so the masking /
--   retention / export rules can be applied. This table is the append-style
--   review queue: one row per (subscriber, field, detected_type) detection,
--   carrying a hash of the offending value (never the cleartext), the
--   detector's confidence, and a review lifecycle (pending → reviewed |
--   dismissed).
--
--   raw_value_hash is a SHA-256 hex of the matched value — it lets a reviewer
--   de-dupe identical detections and confirm a fix without the table storing
--   the very PII it flags.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE subscriber_pii_findings.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_pii_findings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- The custom_fields / merge_fields key the suspect value lived under.
    field_name      text NOT NULL,
    -- The kind of PII the detector matched. Pinned via CHECK so a drifting
    -- detector cannot land an unknown type.
    detected_type   text NOT NULL CHECK (detected_type IN (
                        'ssn', 'credit_card', 'date_of_birth', 'passport',
                        'drivers_license', 'email', 'phone', 'ip_address',
                        'iban', 'other'
                    )),
    -- Detector confidence in [0,1].
    confidence      double precision NOT NULL DEFAULT 0
                        CHECK (confidence >= 0 AND confidence <= 1),
    -- SHA-256 hex of the matched value — never the cleartext.
    raw_value_hash  text NOT NULL,
    -- Review lifecycle.
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'reviewed', 'dismissed'
                    )),
    reviewed_at     timestamptz,
    reviewed_by     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- One open finding per (subscriber, field, detected_type, value-hash) so a
    -- re-scan of an unchanged value does not pile up duplicate rows.
    UNIQUE (tenant_id, subscriber_id, field_name, detected_type, raw_value_hash)
);

COMMENT ON TABLE subscriber_pii_findings IS
    'SUB-071 shadow-PII discovery: undeclared-PII detections in subscriber free-text fields, queued for DPO review.';

-- DPO dashboard / inbox: "pending findings, newest first" for this tenant.
CREATE INDEX IF NOT EXISTS subscriber_pii_findings_status_idx
    ON subscriber_pii_findings (tenant_id, status, created_at DESC);

-- "All findings for subscriber X" — the detail-slideover read shape.
CREATE INDEX IF NOT EXISTS subscriber_pii_findings_subscriber_idx
    ON subscriber_pii_findings (tenant_id, subscriber_id);

CREATE TRIGGER subscriber_pii_findings_set_updated_at
    BEFORE UPDATE ON subscriber_pii_findings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_pii_findings TO postwave_app;

ALTER TABLE subscriber_pii_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_findings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_pii_findings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_pii_findings
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
