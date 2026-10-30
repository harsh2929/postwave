-- 0161_outbound_webhooks_response_redacted.sql
--
-- Forward-fix for C6 (PRODUCTION_READINESS.md): outbound_webhook
-- delivery rows persist the receiver's raw response body in
-- `last_response_body_truncated`. Receivers commonly echo PII
-- (email addresses, tokens) back in their 4xx/5xx error responses,
-- so a tenant's delivery log accumulates third-party PII over time
-- — fine for first-30-days debug, problematic for compliance.
--
-- Schema add:
--   * last_response_body_redacted_at: nullable timestamp marking
--     when the body was scrubbed by the background redaction job.
--   * A scheduled background job (separate from this migration)
--     walks rows older than 7 days where the column is NULL,
--     replaces last_response_body_truncated with a SHA256 hash +
--     length, and stamps the timestamp. Operators querying
--     recent failures still see the raw body for ≤7 days.
--
-- This migration only adds the column. The redaction job lives in
-- apps/api/internal/outbound_webhooks/redact.go (see the
-- corresponding code change in this same commit).

BEGIN;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS last_response_body_redacted_at timestamptz;

CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_redact_pending_idx
    ON outbound_webhook_deliveries (created_at)
    WHERE last_response_body_redacted_at IS NULL
      AND last_response_body_truncated IS NOT NULL;

COMMIT;
