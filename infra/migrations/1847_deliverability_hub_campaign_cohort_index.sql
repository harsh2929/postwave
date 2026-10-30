-- 1847_deliverability_hub_campaign_cohort_index.sql
--
-- The Deliverability Hub evaluates a trailing campaign-send cohort on every
-- GET and worker sample. Existing sent-recipient indexes put subscriber_email
-- or campaign_id before sent_at, forcing a broad historical scan for the
-- account/time predicate at large tenants.
--
-- rollback-strategy: no-op - the index is additive and safe to retain if the application rolls back.
-- rollback-details: DROP INDEX CONCURRENTLY IF EXISTS campaign_recipients_deliverability_cohort_idx only after production query plans show another index serving the same predicate.

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_deliverability_cohort_idx
    ON campaign_recipients (tenant_id, sent_at DESC)
    INCLUDE (campaign_id, subscriber_email)
    WHERE status = 'sent' AND sent_at IS NOT NULL;
