-- 0125_inbound_routes.sql
--
-- Mailgun-Routes-killer: per-tenant inbound email routing rules.
-- The existing inbound_emails ingest writes a row + fires the
-- email_reply automation. With routes the operator can declare:
--
--   "messages to support@* go to the support inbox + tag automatically"
--   "messages with subject prefix [BUG] open a Linear ticket via webhook"
--   "catch-all → store + tag inbound_unmatched"
--
-- Match priority: ascending `priority` (lower = checked first); first
-- match wins UNLESS `stop_on_match=false` (then matching continues
-- to the next rule). This mirrors Mailgun Routes' "stop()" expression.
--
-- Pattern grammar:
--   match_recipient: shell-glob on the To address.
--     "support@*"          — any address at any domain
--     "*@acme.com"         — any user at acme.com
--     "billing+*@acme.com" — plus-tagged billing addresses
--     "*"                  — catch-all
--   match_subject_prefix: literal prefix (case-insensitive)
--   match_from_domain: literal match on the from-domain
--
-- Actions: a JSONB list of typed steps that the dispatcher applies
-- in order. Supported kinds:
--   { kind: "tag", tag: "support" }
--   { kind: "automation_trigger", event_type: "..." }
--   { kind: "webhook", url: "https://..." }   (uses outbound_webhooks signing)
--   { kind: "forward", to: "..." }            (best-effort forward)
--   { kind: "store_only" }                    (no fanout, just inbound_emails row)

BEGIN;

CREATE TABLE IF NOT EXISTS inbound_routes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    name                  text NOT NULL DEFAULT '',
    priority              int  NOT NULL DEFAULT 100,
    stop_on_match         boolean NOT NULL DEFAULT true,
    enabled               boolean NOT NULL DEFAULT true,
    -- Match patterns (any-of: if multiple are set, ALL must match).
    -- Empty means "don't filter on this dimension".
    match_recipient       text NOT NULL DEFAULT '*',
    match_subject_prefix  text NOT NULL DEFAULT '',
    match_from_domain     text NOT NULL DEFAULT '',
    -- Ordered actions.
    actions               jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Runtime stats.
    last_matched_at       timestamptz,
    match_count           int NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_routes_tenant
    ON inbound_routes (tenant_id, priority)
    WHERE enabled = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_routes TO postwave_app;

ALTER TABLE inbound_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON inbound_routes AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The inbound ingest path runs in tenant context already (slug lookup
-- resolves to a tenant), so no worker-permissive policy needed.

-- Track which route matched each inbound_emails row so the
-- dashboard can show "this came in via the support route".
ALTER TABLE inbound_emails
    ADD COLUMN IF NOT EXISTS matched_route_id uuid,
    ADD COLUMN IF NOT EXISTS route_actions_applied jsonb;

CREATE INDEX IF NOT EXISTS idx_inbound_emails_route
    ON inbound_emails (tenant_id, matched_route_id, received_at DESC)
    WHERE matched_route_id IS NOT NULL;

COMMIT;
