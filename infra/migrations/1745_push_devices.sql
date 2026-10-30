-- 1745_push_devices.sql
--
-- G-14 — customer push send-path (APNs/FCM). pushsuppressions (0253) noted
-- "there is no push send path in apps/api today" — this table is the device
-- registry that a real push send path (internal/pushsend) resolves against:
-- given a subscriber, find their enabled push_devices tokens and dispatch
-- through the platform-appropriate provider (APNs for ios, FCM for android).
--
-- This is deliberately separate from mobile_push_devices (1731 and earlier):
-- that table is the Postwave *operator* mobile app's own Expo-relayed push
-- (dashboard/approval notifications for staff). This table is *customer*
-- push — end-subscriber devices enrolled by a tenant's own mobile/web app,
-- addressed directly via APNs/FCM without an Expo relay, and driven by the
-- same omnichannel send path as email/SMS (see push_token_suppressions in
-- 0253 for the companion do-not-send list this send path must consult).
--
-- Tenant-scoped table → tenant_id uuid + RLS, GUC read via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC
-- does not crash the policy. Shape/idiom copied from 1736 and
-- 0450_tenant_custom_field_settings.sql.
--
-- rollback-strategy: no-op - this is a wholly additive table with no reader
-- yet outside the new pushsend package; older application images simply
-- never populate or query it.

BEGIN;

CREATE TABLE IF NOT EXISTS push_devices (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id  uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    platform       text        NOT NULL CHECK (platform IN ('ios', 'android')),
    token          text        NOT NULL CHECK (length(token) > 0),
    app_id         text,
    enabled        boolean     NOT NULL DEFAULT true,
    last_seen_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, token)
);

CREATE INDEX IF NOT EXISTS push_devices_tenant_subscriber_idx
    ON push_devices (tenant_id, subscriber_id)
    WHERE enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON push_devices TO postwave_app;

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_devices FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON push_devices
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE push_devices IS
    'Customer (end-subscriber) push device registry for the APNs/FCM send path in internal/pushsend — distinct from mobile_push_devices, which is the Postwave operator app''s own Expo-relayed push.';
COMMENT ON COLUMN push_devices.app_id IS
    'Provider-specific app identity: APNs bundle id for ios, FCM sender/project id for android. NULL uses the tenant/provider default.';

COMMIT;
