-- AUTH-023 — single-use WebAuthn ceremony nonces.
--
-- The per-ceremony challenge already travels in an HMAC-signed, short-lived
-- cookie (see auth/webauthn.go) that binds purpose + user + tenant + expiry.
-- What the signed cookie ALONE cannot give is single-use: a captured
-- cookie+assertion pair is replayable for the cookie's whole TTL, and the
-- passkeys people actually use (iCloud Keychain / Google Password Manager)
-- report signCount 0, so the WebAuthn clone counter never catches the replay.
--
-- This table closes that gap with minimal state: begin INSERTs the challenge
-- hash, finish DELETE-consumes it, and a second finish with the same cookie
-- finds nothing and is rejected. It is pre-session / pre-tenant (discoverable
-- login has no tenant yet) and stores only opaque SHA-256 hashes + an expiry —
-- no tenant-scoped data — so it carries no RLS policy by design.

BEGIN;

CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge_hash bytea       PRIMARY KEY,
    purpose        text        NOT NULL,
    expires_at     timestamptz NOT NULL
);

COMMENT ON TABLE webauthn_challenges IS
    'AUTH-023 single-use WebAuthn ceremony nonces; opaque SHA-256 hashes, no tenant data, no RLS. Consumed (deleted) on ceremony finish to prevent replay.';

-- Supports the opportunistic GC of expired nonces on each begin. The table is
-- new in this migration, so a plain (non-CONCURRENT) index is safe here.
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_idx
    ON webauthn_challenges (expires_at);

GRANT SELECT, INSERT, DELETE ON webauthn_challenges TO postwave_app;

COMMIT;
