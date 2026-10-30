-- 0406_activation_exclusion_receipts.sql
--
-- Consent-Safe Activation Firewall (feature #2): the tamper-evident
-- ledger of every profile EXCLUDED at a data-activation boundary
-- (audience sync, zerocopy warehouse trigger). The firewall checks
-- per-purpose consent (subscribers.consent_<purpose>_at, 0261) and the
-- unified suppression view (v_suppressions_unified, 0244) BEFORE any
-- row leaves Postwave for a destination, and writes one row here per
-- profile it withheld. The row carries the governing rule
-- (rule_class/rule_reason), the purpose, the destination type, a soft
-- link back to the consent_events ledger (consent_event_id, no FK — the
-- firewall does not own that table), and a per-row HMAC signature so the
-- downloadable receipt CSV is tamper-evident.
--
-- SCOPE NOTE (D4, senior-staff approved 2026-06-15): GDPR Article 15
-- portability exports (exports/walkers.go) are EXPLICITLY EXCLUDED from
-- the firewall — a data subject's right to receive their own data
-- cannot be conditioned on consent to profiling. No row is ever written
-- here for a portability export.
--
-- FAIL-DENY (D1, approved): on a consent-lookup infra error the firewall
-- excludes ALL members (rule_class='policy',
-- rule_reason='consent_lookup_unavailable') rather than leaking profiles
-- in a degraded state. The send loop keeps its contractual fail-open;
-- activation paths are deliberately stricter.
--
-- RETENTION (D5, approved): full rows for 90 days, then a background
-- purger pseudonymises subscriber_email -> SHA-256 in place while
-- retaining rule_class/rule_reason/purpose as the compliance evidence.
--
-- RLS: tenant isolation via the NULLIF tenant-GUC idiom (a raw cast
-- crashes on an unset app.tenant_id — the RLS-dead-worker bug). A
-- RESTRICTIVE gate admits the outbox/worker scope on the READ side so
-- the cross-tenant compliance enumeration can SELECT under
-- db.WithWorkerScope, while WITH CHECK stays tenant-only so worker scope
-- without a bound tenant can read but never write. Mirrors
-- sequence_enrollments (0399) / audience_syncs (0376).
--
-- rollback-strategy: no-op — additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS activation_exclusion_receipts (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- audience_sync_runs.id (uuid, stored as text) or the zerocopy
    -- trigger fire-batch id. Stored as text so both run shapes fit one
    -- column without an FK that would couple the firewall to either
    -- owner table.
    run_id           text NOT NULL,
    run_type         text NOT NULL
                     CHECK (run_type IN ('audience_sync', 'zerocopy_trigger')),
    -- Lowercased subscriber email. Pseudonymised to SHA-256 in place
    -- after the 90-day retention window (D5).
    subscriber_email text NOT NULL,
    rule_class       text NOT NULL
                     CHECK (rule_class IN ('consent', 'suppression', 'policy')),
    -- e.g. 'consent_targeted_ads_at null' | suppression Reason value
    -- ('hard_bounce', 'global_unsubscribe', …) | 'consent_lookup_unavailable'
    -- | 'profile_key_not_email_cannot_check_consent'.
    rule_reason      text NOT NULL,
    -- Soft link to consent_events.id nearest the subscriber's last action
    -- for this purpose; NULL when suppression/policy is the cause. No FK:
    -- this spans the ledger table the firewall package must not own.
    consent_event_id bigint,
    -- One of the five consent.Purpose values.
    purpose          text NOT NULL,
    -- 'webhook' | 'meta' | 'google_ads' | 'warehouse' | 'zerocopy' | …
    destination_type text NOT NULL,
    excluded_at      timestamptz NOT NULL DEFAULT now(),
    -- HMAC-SHA256(server signing key, canonical row fields) for
    -- per-row tamper-evidence. The download endpoint re-signs the whole
    -- CSV with X-Postwave-Receipt-Signature (outbound_webhooks scheme).
    signature        text NOT NULL
);

-- Download-receipt path reads every row for one run.
CREATE INDEX IF NOT EXISTS activation_exclusion_receipts_run_idx
    ON activation_exclusion_receipts (tenant_id, run_id);

-- Per-subscriber audit view ("when/why was this address withheld?").
CREATE INDEX IF NOT EXISTS activation_exclusion_receipts_subscriber_idx
    ON activation_exclusion_receipts (tenant_id, subscriber_email, excluded_at DESC);

-- Range queries for the compliance list endpoint + the retention purger.
CREATE INDEX IF NOT EXISTS activation_exclusion_receipts_recent_idx
    ON activation_exclusion_receipts (tenant_id, excluded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON activation_exclusion_receipts TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE activation_exclusion_receipts_id_seq TO postwave_app;

ALTER TABLE activation_exclusion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_exclusion_receipts FORCE ROW LEVEL SECURITY;

-- RESTRICTIVE gate, ANDed on top of the permissive policy below (the
-- 0325 lesson, applied up-front like 0384/0399). The read side admits
-- worker scope; WITH CHECK stays tenant-only so worker scope without a
-- bound tenant can read but never insert/update receipts.
CREATE POLICY tenant_isolation ON activation_exclusion_receipts
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive tenant policy for request paths (db.WithTenant binds
-- app.tenant_id per tx).
CREATE POLICY tenant_visible ON activation_exclusion_receipts
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant SELECT under db.WithWorkerScope (app.outbox_worker =
-- 'true'), mirroring sequence_enrollments_worker_select (0399). The
-- retention purger re-binds app.tenant_id per row before any write.
CREATE POLICY activation_exclusion_receipts_worker_select ON activation_exclusion_receipts
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
