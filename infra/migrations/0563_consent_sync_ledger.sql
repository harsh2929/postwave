-- 0563_consent_sync_ledger.sql
--
-- SUB-121 — Real-time consent sync ledger.
--
-- Why this migration:
--   When a subscriber unsubscribes (status flips to disabled/blocklisted) or a
--   consent state changes, Postwave's webhook dispatcher fires events to every
--   subscribed downstream tool (CRM, ad platform, ...). But there is no
--   per-destination compliance ledger: an operator cannot answer "did the
--   Klaviyo connector actually receive this unsubscribe, and if it failed, has
--   it been retried?". audience_sync_runs tracks batch ad-platform syncs and
--   webhook_deliveries tracks raw webhook attempts, but neither ties a specific
--   consent/status change to each downstream destination's delivery + retry
--   state.
--
--   This table is that ledger. One row per (subscriber consent/status event,
--   destination) — capturing the destination, the delivery status, an attempt
--   counter, the last attempt time + error, and bookkeeping for an exponential-
--   backoff retry worker (max 5 attempts over ~24h). It lets a DPO audit which
--   downstream tools got the unsubscribe signal and surface the failed ones for
--   manual intervention.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE consent_sync_ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS consent_sync_ledger (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id     uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- The consent/status event being propagated. Pinned via CHECK.
    event_type        text NOT NULL CHECK (event_type IN (
                          'unsubscribe', 'consent_revoked', 'consent_granted',
                          'status_change'
                      )),
    -- The downstream destination this row tracks delivery to. destination_id is
    -- a free-text identifier for the connector/webhook; destination_url is the
    -- resolved endpoint (may be empty for a logical destination).
    destination_id    text NOT NULL,
    destination_url   text NOT NULL DEFAULT '',
    -- Delivery lifecycle. 'pending' = queued, 'delivered' = ack'd, 'failed' =
    -- gave up after max attempts, 'retrying' = a transient failure awaiting the
    -- next backoff window.
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'delivered', 'retrying', 'failed'
                      )),
    attempt_count     integer NOT NULL DEFAULT 0,
    last_attempted_at timestamptz,
    -- When the retry worker should next attempt this row (NULL = attempt asap).
    next_attempt_at   timestamptz,
    last_error        text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- One ledger row per (subscriber, event, destination) so a re-fire of the
    -- same event to the same destination updates the existing attempt counter
    -- rather than piling up duplicates.
    UNIQUE (tenant_id, subscriber_id, event_type, destination_id)
);

COMMENT ON TABLE consent_sync_ledger IS
    'SUB-121 per-destination delivery+retry ledger for subscriber consent/unsubscribe propagation.';

-- "All ledger rows for subscriber X" — the per-subscriber audit read shape.
CREATE INDEX IF NOT EXISTS consent_sync_ledger_subscriber_idx
    ON consent_sync_ledger (tenant_id, subscriber_id, created_at DESC);

-- Retry worker claim shape: rows that still need work, ordered by when they are
-- due. Partial so it stays tiny (the common case is 'delivered').
CREATE INDEX IF NOT EXISTS consent_sync_ledger_retry_idx
    ON consent_sync_ledger (next_attempt_at)
    WHERE status IN ('pending', 'retrying');

CREATE TRIGGER consent_sync_ledger_set_updated_at
    BEFORE UPDATE ON consent_sync_ledger
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON consent_sync_ledger TO postwave_app;

ALTER TABLE consent_sync_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_sync_ledger FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consent_sync_ledger
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON consent_sync_ledger
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
