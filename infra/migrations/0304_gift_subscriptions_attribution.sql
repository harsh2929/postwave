-- 0304_gift_subscriptions_attribution.sql
--
-- Gift Subscriptions — sender attribution (word-of-mouth signal).
--
-- Existing gift_subscriptions (0074 + 0181 + 0219) tracks
-- purchaser_email / recipient_email but never resolves the purchaser
-- to a subscribers row. That makes the "Sender retains attribution"
-- promise from the audit unmeasurable: when a redeemed gift converts
-- the recipient into a paid subscriber, we can attribute the new
-- subscription to "email = alice@…" but not to "subscriber-id =
-- 04a2…". Operators ask "which existing members are our best
-- referrers via gifts?" — and we couldn't answer because the join
-- key wasn't stored.
--
-- This migration adds:
--
--   * gifter_subscriber_id — the giver as a subscribers row. NULL
--     when the giver isn't a tenant-managed subscriber (e.g. a
--     never-subscribed Stripe customer who bought a gift via
--     checkout). FK SET NULL on subscriber delete so the row
--     survives a giver-side GDPR purge without losing the gift
--     itself.
--
--   * gifter_attribution_token — short opaque code stamped onto the
--     redemption URL as a query param (?ref=…). Lets the public
--     redemption page emit a "you were gifted by Alice" tile
--     without needing to expose the giver's row id. Distinct from
--     redemption_token (which is the auth factor) so that rotating
--     one doesn't break the other.
--
--   * gift_attribution_events — denormalised projection that
--     captures the giver→redeemed-subscriber join at redemption
--     time so the attribution report stays O(1) regardless of how
--     many gifts a giver fired. Refreshed by the RedeemGift path.
--
-- Both columns are nullable; existing rows survive untouched. The
-- companion paid_tiers Go code falls back to email-match lookups
-- when gifter_subscriber_id is unset, preserving legacy behaviour.

BEGIN;

ALTER TABLE gift_subscriptions
    ADD COLUMN IF NOT EXISTS gifter_subscriber_id      uuid
        REFERENCES subscribers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS gifter_attribution_token  text;

-- Index for the attribution report's "top givers" query. Partial on
-- non-NULL so the scan only touches rows that actually carry
-- attribution metadata (older rows + Stripe-direct gifts excluded).
CREATE INDEX IF NOT EXISTS gift_subscriptions_gifter_idx
    ON gift_subscriptions (tenant_id, gifter_subscriber_id)
    WHERE gifter_subscriber_id IS NOT NULL;

-- Unique index on the attribution token so the public redemption
-- page can resolve ?ref=<token> without leaking giver row ids.
CREATE UNIQUE INDEX IF NOT EXISTS gift_subscriptions_attrib_token_idx
    ON gift_subscriptions (gifter_attribution_token)
    WHERE gifter_attribution_token IS NOT NULL;

-- Denormalised attribution event log — one row per redeemed gift.
-- Powers the "word-of-mouth funnel" report:
--   total gifts sent → redeemed → conversion rate → top givers.
-- Separated from gift_subscriptions so the funnel report can be
-- summarised without scanning expired / pending rows, and so the
-- gift row can be deleted (GDPR) while preserving the aggregate
-- attribution signal (giver_subscriber_id is also nullable + FK
-- SET NULL).
CREATE TABLE IF NOT EXISTS gift_attribution_events (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    gift_id                  uuid REFERENCES gift_subscriptions(id) ON DELETE SET NULL,
    gifter_subscriber_id     uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    gifter_email             citext NOT NULL,
    redeemed_subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    redeemed_email           citext NOT NULL,
    plan_id                  text NOT NULL,
    duration_months          smallint NOT NULL,
    redeemed_at              timestamptz NOT NULL DEFAULT now(),
    created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gift_attribution_events_tenant_idx
    ON gift_attribution_events (tenant_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS gift_attribution_events_gifter_idx
    ON gift_attribution_events (tenant_id, gifter_subscriber_id)
    WHERE gifter_subscriber_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gift_attribution_events_gifter_email_idx
    ON gift_attribution_events (tenant_id, gifter_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON gift_attribution_events TO postwave_app;

ALTER TABLE gift_attribution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_attribution_events FORCE  ROW LEVEL SECURITY;

-- Standard tenant isolation idiom (mirrors 0074's restrictive
-- policy on gift_subscriptions). No public-token bypass here —
-- this table is operator-only.
CREATE POLICY tenant_isolation ON gift_attribution_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON gift_attribution_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
