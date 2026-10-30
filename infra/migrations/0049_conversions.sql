-- 0049_conversions.sql
--
-- Conversion tracking + revenue attribution.
--
-- Two surfaces:
--
--   1. /api/public/track/conversion — a public, no-auth pixel +
--      JSON endpoint hit from a tenant's website to record "this
--      person bought / signed up / converted." Tenant identifies via
--      a public-key (separate from API keys; safe to ship in
--      page-side JS).
--
--   2. campaign_report_events insertion with event_type='conversion'
--      so the existing analytics pipeline (digest cron, /campaigns/
--      {id}/report aggregator, SSE stream) picks up conversions
--      alongside opens / clicks / bounces.
--
-- The conversions table mirrors the per-event fact shape but adds:
--
--   - subscriber_email (citext, optional) — who converted
--   - amount_cents — revenue value, NULL when the event isn't
--     monetary (e.g. "trial-signup" without billing)
--   - currency — ISO 4217; NULL when amount is NULL
--   - event_name — tenant-defined ("checkout.complete", "trial.start", …)
--   - campaign_id — best-effort attribution to a recent campaign,
--     populated by the ingestion handler if a tracking cookie or
--     query param identifies the campaign that drove the click.
--   - properties — freeform jsonb for extra context
--
-- Why not just use campaign_report_events? Because conversions can
-- happen WITHOUT a campaign attribution (a subscriber buys via the
-- homepage, no email involved). Storing conversions in their own
-- table lets us query "all conversions for this tenant" without a
-- campaign_id filter — but we still mirror them into
-- campaign_report_events when attribution is known, so the per-
-- campaign report endpoint sees them.

BEGIN;

-- Public tracking keys: like API keys but write-only and
-- conversion-scoped. Tenant ships the key in their site's JS; an
-- attacker can use it only to insert conversion events for that
-- tenant (no read access to anything). We hash at rest like API
-- keys, and the public-track handler resolves prefix → tenant via
-- a separate hash → tenant lookup.
CREATE TABLE conversion_tracking_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label       text NOT NULL DEFAULT 'web',
    prefix      text NOT NULL,
    key_hash    text NOT NULL,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversion_tracking_keys_hash_idx
    ON conversion_tracking_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX conversion_tracking_keys_tenant_idx
    ON conversion_tracking_keys (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_tracking_keys TO postwave_app;

ALTER TABLE conversion_tracking_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_tracking_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversion_tracking_keys
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy for the public-track handler, which resolves
-- the key WITHOUT a tenant context (it doesn't know the tenant
-- yet). Same pattern as api_keys' app.api_key_hash GUC.
CREATE POLICY conversion_tracking_keys_public_lookup ON conversion_tracking_keys
    AS PERMISSIVE
    FOR SELECT
    USING (
      key_hash = current_setting('app.conversion_track_hash', true)
      AND revoked_at IS NULL
    );

-- The conversion fact table.
CREATE TABLE conversions (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext,
    -- Tenant-defined event name. We don't constrain so tenants can
    -- track whatever fits their funnel.
    event_name       text NOT NULL,
    -- Revenue. amount_cents NULL = non-monetary conversion.
    amount_cents     bigint,
    currency         text,                              -- ISO 4217, e.g. 'USD'
    -- Best-effort attribution. NULL = no campaign attribution.
    campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- Freeform context (order_id, referrer, UTM tags, …).
    properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversions_tenant_at_idx
    ON conversions (tenant_id, occurred_at DESC);
CREATE INDEX conversions_tenant_event_idx
    ON conversions (tenant_id, event_name, occurred_at DESC);
CREATE INDEX conversions_campaign_idx
    ON conversions (tenant_id, campaign_id, occurred_at DESC)
    WHERE campaign_id IS NOT NULL;

GRANT SELECT, INSERT ON conversions TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE conversions_id_seq TO postwave_app;

ALTER TABLE conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive insert policy for the public-track handler — same
-- shape as the lookup policy above.
CREATE POLICY conversions_public_insert ON conversions
    AS PERMISSIVE
    FOR INSERT
    WITH CHECK (
      tenant_id::text = current_setting('app.public_conversion_tenant', true)
    );

COMMIT;
