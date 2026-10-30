-- 0396_retention_winback_sends.sql
--
-- close-open-loops: churn win-back e-mail delivery + cooldown.
--
-- Background: the WinbackWorker (internal/retention_offers/winback.go)
-- historically only logged a 'shown' retention_offer_events row when it
-- enrolled a churn-threshold crosser — it never actually SENT anything,
-- so the "win-back" was an open loop. This migration backs the real
-- delivery path: a per-(tenant, subscriber) send ledger that gives the
-- worker an idempotency / no-spam cooldown marker.
--
-- One row per win-back e-mail we hand to the platform mailer. The worker
-- consults it BEFORE sending to enforce a cooldown (default 30 days):
-- a subscriber who was e-mailed inside the window is skipped, so the
-- worker is safe to run on every tick without re-spamming. We key the
-- cooldown on (tenant_id, subscriber_email) — independent of which offer
-- was current — because the cooldown is a per-person promise, not a
-- per-offer one. offer_id is retained for audit/debug.
--
-- We deliberately do NOT reuse the retention_offer_events 'shown' row as
-- the cooldown marker: 'shown' is the funnel-entry event (and is also
-- written by the portal cancel-flow modal), whereas a send is a distinct
-- act with its own retention/PII lifecycle. Keeping them separate means
-- the cooldown survives even if the funnel rollup is later trimmed, and
-- a manual portal 'shown' never silently suppresses an e-mail.
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair on the
-- `NULLIF(current_setting('app.tenant_id', true), '')::uuid` idiom (the
-- raw cast crashes when the GUC is unset). The worker scans this table
-- under db.WithTenant (per-tenant, app.tenant_id bound), so the tenant
-- policies serve every read/write. We ALSO add a worker_select policy
-- mirroring voice_sequences_worker_select (0395) so a future
-- cross-tenant cooldown audit under db.WithWorkerScope is not a silent
-- RLS dead-read — this is the exact dead-worker class this branch fixed.

BEGIN;

CREATE TABLE IF NOT EXISTS retention_winback_sends (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The offer that was current when we sent. Kept for audit; the
    -- cooldown key intentionally excludes it (see header).
    offer_id         UUID NOT NULL REFERENCES retention_offers(id) ON DELETE CASCADE,
    -- Lower-cased recipient address. Matches the casing convention the
    -- rest of the package writes (LogEvent lower-cases subscriber_email).
    subscriber_email TEXT NOT NULL,
    -- Which churn signal selected this subscriber: 'commerce' (from
    -- profile_predictions.churn_risk) or 'engagement' (recency of last
    -- open/click in campaign_report_events). Surfaced for analytics so
    -- ops can compare conversion by signal source.
    churn_source     TEXT NOT NULL DEFAULT 'commerce'
        CHECK (churn_source IN ('commerce', 'engagement')),
    -- The churn risk (0..1) at send time, for after-the-fact tuning.
    churn_risk       DOUBLE PRECISION,
    sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A subscriber is e-mailed at most once per tenant+address+sent_at
    -- instant; the cooldown window check is a range scan on the index
    -- below, so we don't need a uniqueness constraint on the address.
    UNIQUE (tenant_id, offer_id, subscriber_email, sent_at)
);

-- Cooldown lookup: "most recent send to this address" is a backwards
-- index scan on (tenant_id, lower(email), sent_at DESC).
CREATE INDEX IF NOT EXISTS retention_winback_sends_cooldown_idx
    ON retention_winback_sends (tenant_id, lower(subscriber_email), sent_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_winback_sends TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE retention_winback_sends_id_seq TO postwave_app;

ALTER TABLE retention_winback_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_winback_sends FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON retention_winback_sends
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON retention_winback_sends
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant cooldown audit path (db.WithWorkerScope). Read-only:
-- SELECT-only and gated on app.outbox_worker so a tenant-scoped read
-- can never use it to escape its tenant.
CREATE POLICY retention_winback_sends_worker_select ON retention_winback_sends
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
