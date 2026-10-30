-- 0126_streams.sql
--
-- Transactional vs Marketing stream classification.
--
-- One sender identity, one reputation, but per-message classification
-- so:
--   * Suppression queries can be scoped per stream (transactional
--     receipts ignore the marketing global unsubscribe; marketing
--     respects everyone).
--   * EQ Score thresholds can differ (tx tolerates much higher spam-
--     scoring boilerplate like password URLs).
--   * Analytics can split the two without losing the shared reputation
--     story ("our marketing stream's open rate is X, our tx is Y, both
--     run on the same warmed IPs").
--
-- Stream values: 'transactional' | 'marketing' | 'broadcast'
-- (broadcast = newsletters, marketing = automated sequences).

BEGIN;

-- Per-campaign stream classification. Default 'marketing' so the
-- shipped product behaviour doesn't change unless the operator opts
-- in. Tx + broadcast both must be set explicitly.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS stream text NOT NULL DEFAULT 'marketing'
        CHECK (stream IN ('transactional','marketing','broadcast'));

CREATE INDEX IF NOT EXISTS idx_campaigns_stream
    ON campaigns (tenant_id, stream, created_at DESC);

-- Per-suppression stream scope. Empty (NULL) = "applies to every
-- stream"; otherwise pinned. The dispatcher consults this when
-- deciding whether a suppression applies to the current send.
ALTER TABLE subscriber_suppressions
    ADD COLUMN IF NOT EXISTS scope_stream text
        CHECK (scope_stream IS NULL OR scope_stream IN ('transactional','marketing','broadcast'));

CREATE INDEX IF NOT EXISTS idx_subscriber_suppressions_scope_stream
    ON subscriber_suppressions (tenant_id, email, scope_stream)
    WHERE scope_stream IS NOT NULL;

-- Per-event stream so analytics can split deliverability by stream
-- without joining back to campaigns.
ALTER TABLE subscriber_events
    ADD COLUMN IF NOT EXISTS stream text
        CHECK (stream IS NULL OR stream IN ('transactional','marketing','broadcast'));

CREATE INDEX IF NOT EXISTS idx_subscriber_events_stream
    ON subscriber_events (tenant_id, stream, at DESC)
    WHERE stream IS NOT NULL;

COMMIT;
