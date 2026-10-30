-- 1629_cli_device_grants.sql
--
-- OAuth 2.0 Device Authorization Grant (RFC 8628) for the CLI / headless login.
-- The existing cli_auth_grants table (1622) backs the loopback-redirect + PKCE
-- flow (RFC 8252), which needs a browser on the SAME machine as the CLI. That
-- breaks for headless / SSH sessions, where the device grant is the standard
-- answer: the CLI shows a short user_code + a verification_uri, the user opens
-- that URL in ANY browser and approves, and the CLI polls for the key.
--
-- Like cli_auth_grants this table has NO tenant RLS by design — the public
-- /device/start and /device/token endpoints carry no session/tenant GUC and
-- look the grant up by its high-entropy device_code_hash (or the user_code,
-- which the approving user types under their own session). tenant_id is NULL
-- until an authenticated user approves, at which point the row is bound to that
-- user's tenant so the minted key is scoped correctly.

BEGIN;

CREATE TABLE IF NOT EXISTS cli_device_grants (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- sha256(device_code): the CLI's secret, polled at /device/token.
    device_code_hash text NOT NULL UNIQUE,
    -- The short human-typable code shown by the CLI and entered in the
    -- browser. Stored normalized (uppercase, no separator).
    user_code        text NOT NULL UNIQUE,
    -- NULL until an authenticated user approves; then bound to their tenant.
    tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          uuid,
    email            text,
    scopes           text[] NOT NULL DEFAULT '{}',
    status           text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'consumed', 'denied')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    -- For the RFC 8628 slow_down signal: the last time the CLI polled.
    last_polled_at   timestamptz,
    approved_at      timestamptz,
    consumed_at      timestamptz
);

-- Pending lookup by user_code is the approve path's hot query.
CREATE INDEX IF NOT EXISTS cli_device_grants_user_code_idx
    ON cli_device_grants (user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS cli_device_grants_expiry_idx
    ON cli_device_grants (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON cli_device_grants TO postwave_app;

COMMIT;
