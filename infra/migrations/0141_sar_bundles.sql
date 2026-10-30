-- 0141_sar_bundles.sql
--
-- Subject Access Request bundles — GDPR Article 15 (right of
-- access by the data subject) and CCPA §1798.100 (consumer right
-- to know). A subscriber (or their representative) can demand a
-- copy of every piece of personal data the operator holds about
-- them; the operator has 30 days (GDPR) / 45 days (CCPA) to
-- respond.
--
-- Distinct from the tenant-level data export in
-- privacy_requests / DownloadExport:
--   * tenant export = Article 20 (data portability), entire workspace
--   * SAR bundle    = Article 15 (right of access), one subscriber
--
-- The bundle itself is denormalized JSON — point-in-time snapshot
-- of (subscriber row + events + consent receipts + form
-- submissions + preferences). Stored inline because per-subscriber
-- data is bounded (rarely >MB) so we avoid object-storage
-- plumbing. Auditors expect both the request and the served bundle
-- to be retrievable.

BEGIN;

CREATE TABLE IF NOT EXISTS sar_bundles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    -- 'pending' is a transient state for very-large bundles; the
    -- happy path is synchronous and lands in 'ready' immediately.
    status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready','failed')),
    -- Compliance counters (cheap to read without parsing the bundle).
    event_count     int NOT NULL DEFAULT 0,
    consent_count   int NOT NULL DEFAULT 0,
    bundle_bytes    int NOT NULL DEFAULT 0,
    -- The frozen snapshot — null while pending or after failure.
    bundle          jsonb,
    requested_by    text,          -- 'admin:<user_email>' | 'subscriber:<token>' | 'support:<ticket>'
    requested_at    timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,
    -- Optional regional SLA stamp for the auditor trail.
    region          text,
    error           text
);

-- Hot path: "show me every SAR for this subscriber" (auditor view).
CREATE INDEX IF NOT EXISTS idx_sar_bundles_subscriber
    ON sar_bundles (tenant_id, subscriber_email, requested_at DESC);

-- Listing view: "every SAR for this tenant, newest first".
CREATE INDEX IF NOT EXISTS idx_sar_bundles_tenant_time
    ON sar_bundles (tenant_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE ON sar_bundles TO postwave_app;

ALTER TABLE sar_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON sar_bundles AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
