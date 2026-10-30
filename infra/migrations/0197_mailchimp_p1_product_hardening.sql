-- 0197_mailchimp_p1_product_hardening.sql
--
-- Mailchimp P1 parity hardening:
--   * Custom-report filters now lean on source/channel/device/date indexes.
--   * Delivery cancellation updates pending + in-flight queue rows; this
--     index keeps provider-facing cancellation views fast.
--   * Click-map and planner rollups group by link_url and metadata channel.

BEGIN;

CREATE INDEX IF NOT EXISTS campaign_report_events_channel_idx
    ON campaign_report_events (tenant_id, (COALESCE(metadata->>'channel', 'email')), at DESC);

CREATE INDEX IF NOT EXISTS campaign_report_events_source_idx
    ON campaign_report_events (tenant_id, source, at DESC);

CREATE INDEX IF NOT EXISTS campaign_report_events_link_idx
    ON campaign_report_events (tenant_id, campaign_id, link_url)
    WHERE link_url IS NOT NULL AND link_url <> '';

CREATE INDEX IF NOT EXISTS campaign_recipients_cancellable_idx
    ON campaign_recipients (tenant_id, campaign_id, status)
    WHERE status IN ('pending', 'sending');

COMMIT;
