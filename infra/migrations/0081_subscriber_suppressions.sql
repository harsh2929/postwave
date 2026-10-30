-- 0081_subscriber_suppressions.sql
--
-- Bounce + engagement webhook loop for the deliverability product. This
-- migration introduces `subscriber_suppressions`, the canonical
-- per-tenant suppression list consulted by the send loop on every
-- outbound dispatch. It deliberately co-exists with the legacy
-- `email_suppressions` (0030) and the older `suppressions` (0060)
-- tables — those are still referenced by the Mailchimp-compat surface
-- and the pre-X1 admin UI respectively. New deliverability code (the
-- bounce + engagement webhook receivers in apps/api/internal/webhooks/
-- and the send-loop filter in apps/api/internal/sending/sendloop.go)
-- targets THIS table only.
--
-- Schema highlights:
--   - reason is enum-like via CHECK so we can lint at write time
--     (`hard_bounce`, `spam_complaint`, `manual_unsubscribe`, …).
--   - source is the provider that fed the suppression, used to
--     attribute back to a webhook receiver during incident triage.
--   - source_event_id pulls the provider's event id forward so
--     duplicate webhook deliveries are no-ops (UPSERT idempotency).
--   - expires_at lets time-limited suppressions auto-clear (e.g.
--     soft-bounce-threshold rolls off after 30d).
--   - metadata jsonb is a free-form bag the webhook receivers fill
--     with provider-specific payload bits (smtp code, server response
--     etc.) that operators want when investigating a bounce.
--
-- RLS: PERMISSIVE FOR ALL gated by app.tenant_id, mirroring the
-- canonical pattern landed in 0079 (which back-filled the missing
-- PERMISSIVE policies on a dozen tables). NOT a RESTRICTIVE-only
-- policy — that's the always-deny bug 0079 was written to fix.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE subscriber_suppressions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           citext NOT NULL,
    reason          text NOT NULL CHECK (reason IN (
        'hard_bounce',
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold'
    )),
    source          text NOT NULL DEFAULT 'manual' CHECK (source IN (
        'postmark', 'mailgun', 'ses', 'manual', 'api', 'import'
    )),
    source_event_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (tenant_id, email)
);

CREATE INDEX subscriber_suppressions_tenant_email_idx
    ON subscriber_suppressions (tenant_id, email);

CREATE INDEX subscriber_suppressions_tenant_expires_idx
    ON subscriber_suppressions (tenant_id, expires_at)
    WHERE expires_at IS NOT NULL;

-- Idempotency on duplicate webhook deliveries: same (tenant, source,
-- source_event_id) tuple must collapse to a single insert. Partial
-- unique so rows without a provider event id (e.g. manual ops adds)
-- don't collide.
CREATE UNIQUE INDEX subscriber_suppressions_source_event_unique
    ON subscriber_suppressions (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_suppressions TO postwave_app;

ALTER TABLE subscriber_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_suppressions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON subscriber_suppressions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
