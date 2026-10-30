-- 0110_webhook_signing_algorithms.sql
-- Adds multi-algorithm signing + dual-sign rotation to outbound_webhooks.
--
-- New columns:
--   * signing_algorithm: which scheme produces the X-Postwave-Signature
--     header. Defaults to 'hmac_sha256' so existing rows + subscribers
--     keep working byte-identically.
--   * signing_public_key: ASCII PEM of the public key for ECDSA / Ed25519
--     webhooks. Returned by GET /api/v1/outbound-webhooks/{id} so the
--     subscriber can verify without contacting us.
--   * secondary_*: the rotation grace-window key. When set, the worker
--     signs the body with BOTH keys and emits a header containing two
--     signature tags, e.g. "t=...,v1=...,v3=..." or "t=...,v3=...,v3=...".
--     secondary_expires_at is when the secondary key is automatically
--     dropped (default 24h after rotation).
--
-- The lifecycle:
--   1. Rotate endpoint generates fresh keying material for the same
--      algorithm and demotes the current key to secondary_*.
--   2. Worker dual-signs every delivery for the grace window.
--   3. A janitor sweep (or any handler) clears the secondary_* columns
--      once secondary_expires_at < now().

BEGIN;

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS signing_algorithm        text NOT NULL DEFAULT 'hmac_sha256'
        CHECK (signing_algorithm IN ('hmac_sha256','ecdsa_p256','ed25519')),
    ADD COLUMN IF NOT EXISTS signing_public_key       text,
    ADD COLUMN IF NOT EXISTS secondary_secret_envelope bytea,
    ADD COLUMN IF NOT EXISTS secondary_public_key      text,
    ADD COLUMN IF NOT EXISTS secondary_expires_at      timestamptz,
    ADD COLUMN IF NOT EXISTS rotated_at                timestamptz;

-- Speed up the janitor sweep that drops expired secondary keys.
CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_secondary_expiry
    ON outbound_webhooks (secondary_expires_at)
    WHERE secondary_expires_at IS NOT NULL;

COMMIT;
