-- 1112_subscriber_group_memberships.sql
--
-- SUB-117 — Group Membership API for storefront.
--
-- Real-time group membership query for site/app personalization. Until now,
-- a subscriber's group membership lived in two places that were both awkward
-- for a hot-path lookup:
--   1. subscriber_groups (migration 0028) — the group *definitions* (category,
--      name, type, display_order). It has no membership rows.
--   2. subscribers.groups jsonb — the *membership* data, embedded on the
--      subscriber row as an array of {name, ...} objects. Reading "is this
--      subscriber in group X" or "all members of group X" out of jsonb means
--      a GIN scan over a large array column — fine for the admin UI, too slow
--      for a per-pageview storefront personalization call.
--
-- This migration adds a lightweight many-to-many junction table so a
-- storefront can answer "which groups is this profile in?" with a single
-- index lookup. The companion migration (1113) backfills it from the
-- existing subscribers.groups jsonb so day-one reads are non-empty.
--
-- The two composite indexes mirror the dominant read shapes:
--   * (tenant_id, subscriber_id) — "all groups for subscriber X" (the
--     personalization lookup).
--   * (tenant_id, group_id)      — "all members of group X" (audience export).
--
-- A public-lookup RLS policy (gated on the app.public_group_tenant GUC, the
-- same shape conversion_tracking_keys' public lookup uses) lets the
-- storefront read path resolve memberships after it has authenticated the
-- caller's public site key and bound the tenant id — without granting the
-- public path a full app.tenant_id session.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- subscriber_group_memberships.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_group_memberships (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    group_id      uuid NOT NULL REFERENCES subscriber_groups(id) ON DELETE CASCADE,
    joined_at     timestamptz NOT NULL DEFAULT now(),
    -- One membership row per (subscriber, group) per tenant. A re-add is an
    -- ON CONFLICT DO NOTHING no-op rather than a duplicate row.
    UNIQUE (tenant_id, subscriber_id, group_id)
);

-- "All groups for subscriber X" — the storefront personalization lookup.
CREATE INDEX IF NOT EXISTS subscriber_group_memberships_subscriber_idx
    ON subscriber_group_memberships (tenant_id, subscriber_id);

-- "All members of group X" — audience export / counts.
CREATE INDEX IF NOT EXISTS subscriber_group_memberships_group_idx
    ON subscriber_group_memberships (tenant_id, group_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_group_memberships TO postwave_app;

ALTER TABLE subscriber_group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_group_memberships FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_group_memberships
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_group_memberships
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public storefront read path: after the public handler authenticates the
-- caller's site key and binds app.public_group_tenant to the resolved tenant
-- id, this permissive SELECT-only policy lets it read that tenant's
-- membership rows without an app.tenant_id session. Mirrors the
-- conversion_tracking_keys public-lookup idiom (NULLIF guard so an unset GUC
-- never crashes the policy).
CREATE POLICY public_group_lookup ON subscriber_group_memberships
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.public_group_tenant', true), '')::uuid);

COMMIT;
