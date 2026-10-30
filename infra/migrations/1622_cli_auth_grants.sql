-- 1622_cli_auth_grants.sql
--
-- Pending grants for the CLI / editor login flow (OAuth 2.0 authorization-code
-- + PKCE over a loopback redirect, RFC 8252 / 7636). The browser /cli/auth page
-- — only after the signed-in user clicks "Authorize" — records a grant here and
-- hands the CLI a short-lived one-time CODE (not a key). The CLI then exchanges
-- the code + its PKCE code_verifier at POST /api/v1/auth/cli/token for the
-- actual API key, over a direct backend call. The key never travels through the
-- browser, and an intercepted code is useless without the verifier.
--
-- No tenant RLS by design: the public token-exchange endpoint has no session /
-- tenant GUC and must look the grant up by its high-entropy code_hash (the
-- secret). Same shape as other unguessable-token tables. tenant_id is carried
-- on the row so the minted key is scoped correctly.

BEGIN;

CREATE TABLE IF NOT EXISTS cli_auth_grants (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL,
    email            text,
    code_hash        text NOT NULL UNIQUE,
    code_challenge   text NOT NULL,
    challenge_method text NOT NULL DEFAULT 'S256',
    state            text NOT NULL,
    port             integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    scopes           text[] NOT NULL DEFAULT '{}',
    status           text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'consumed')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    consumed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS cli_auth_grants_expiry_idx ON cli_auth_grants (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON cli_auth_grants TO postwave_app;

COMMIT;
