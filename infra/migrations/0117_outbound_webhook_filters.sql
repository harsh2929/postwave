-- 0117_outbound_webhook_filters.sql
--
-- Per-webhook filter + transformation. Lets one inbound event fan out
-- to N downstream webhooks where each webhook independently decides
-- whether the event is relevant (filter_expression) and optionally
-- reshapes the payload (transform_template) before dispatch.
--
-- filter_expression: a path-equality DSL evaluated against the event
--   payload JSON. Format: "field.path == value" with && / || combinators.
--   Examples:
--     "subscriber.tags includes vip"
--     "campaign.recipients_count > 1000"
--     "subscriber.status == active && subscriber.country == US"
--   Empty / NULL means "always match" — preserves backward compat.
--
-- transform_template: a JSON-Pointer-style projection that selects /
--   renames fields. Format: {"out_field": "/in/path", ...}. NULL means
--   "send payload as-is" (the legacy contract).
--
-- Both are validated at insert time and re-validated whenever they're
-- updated; invalid expressions are rejected with a 422.

BEGIN;

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS filter_expression text,
    ADD COLUMN IF NOT EXISTS transform_template jsonb;

CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_has_filter
    ON outbound_webhooks (tenant_id)
    WHERE filter_expression IS NOT NULL OR transform_template IS NOT NULL;

COMMIT;
