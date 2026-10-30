-- 1844_auth_trusted_devices.sql
--
-- AUTH#48 — "remember this device" for MFA.
--
-- WHAT THIS IS. A device-trust record is a SECOND client credential, entirely
-- separate from the session cookie: its own opaque (id, verifier) pair, its own
-- HMAC pepper (domain-separated from the session pepper — see
-- apps/api/internal/auth/device_trust.go), and its own lifetime. Holding it
-- lets a BRAND NEW session start already MFA-satisfied, which is precisely what
-- a session-scoped mfa_satisfied flag can never do and is the whole point of
-- the feature.
--
-- WHY THE ROW IS A DEVICE, NOT A SESSION. auth_sessions rows die on logout,
-- expiry and password reset. Trust has to outlive all three or it does nothing.
-- So this table is keyed on its own credential and holds one record per
-- (tenant, user, device); sessions come and go underneath it.
--
-- THIS DELIBERATELY WEAKENS MFA, so the schema carries the guard rails:
--
--   * trust_days is CHECK-constrained to EXACTLY 30, 90 or 180. The product
--     owner approved those three values and 180 as the hard maximum. The API
--     validates the same set before it ever gets here (see TOTPChallenge), and
--     this constraint is the second, non-bypassable copy: no future code path,
--     migration script or manual INSERT can mint a 365-day trust.
--   * expires_at is ABSOLUTE from issuance. Nothing in the application updates
--     it; use only touches last_used_at. A trusted device therefore cannot be
--     kept alive indefinitely by being used.
--   * revoked_at makes every record killable, individually or in bulk, from the
--     user's own devices list.
--
-- Also adds tenant_security_settings.allow_trusted_devices. A workspace that
-- runs require_2fa_for_admins may consider device trust a policy violation;
-- this is their server-side off switch. It DEFAULTS TO TRUE because the owner
-- approved the feature — the opt-out is opt-in.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Purely additive — one new table plus one new column with a
--   safe default. Rolling back means DROP TABLE auth_trusted_devices and
--   ALTER TABLE tenant_security_settings DROP COLUMN allow_trusted_devices; no
--   existing column, policy or grant is modified, so a rollback cannot strand
--   in-flight sessions. Re-runnable: every statement is IF NOT EXISTS / DROP
--   POLICY IF EXISTS guarded.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS auth_trusted_devices (
    -- Opaque base64url id, the public half of the trust cookie. TEXT (not
    -- uuid) to match auth_sessions.id: it is a token, not a database key.
    id             text PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- HMAC-SHA256(verifier, DEVICE-TRUST pepper). The verifier itself is never
    -- stored, and the pepper is NOT the session pepper.
    verifier_hash  bytea NOT NULL,
    -- The duration the user chose, retained so the devices list can say
    -- "trusted for 90 days" rather than making the client subtract dates.
    trust_days     integer NOT NULL,
    -- Server-normalised device label at issuance time, for the devices list.
    label          text NOT NULL DEFAULT '',
    user_agent     text NOT NULL DEFAULT '',
    ip             inet,
    issued_at      timestamptz NOT NULL DEFAULT now(),
    -- Absolute. Never extended by use.
    expires_at     timestamptz NOT NULL,
    last_used_at   timestamptz,
    revoked_at     timestamptz,
    CONSTRAINT auth_trusted_devices_trust_days_allowed
        CHECK (trust_days IN (30, 90, 180))
);

COMMENT ON TABLE auth_trusted_devices IS
    'AUTH#48 device-trust credentials. One row per (tenant, user, device); a second client credential that lets a NEW session start MFA-satisfied. trust_days is CHECK-constrained to the three owner-approved values (30/90/180); expires_at is absolute and is never extended by use.';

COMMENT ON COLUMN auth_trusted_devices.expires_at IS
    'Absolute expiry, fixed at issuance. Application code updates last_used_at only — a trust record must never be silently extended by being used.';

-- Listing the caller's trusted devices, and the bulk revoke, both scan by
-- (tenant_id, user_id).
CREATE INDEX IF NOT EXISTS auth_trusted_devices_user_idx
    ON auth_trusted_devices (tenant_id, user_id, issued_at DESC);

-- Housekeeping sweep for records that are dead either way.
CREATE INDEX IF NOT EXISTS auth_trusted_devices_expiry_idx
    ON auth_trusted_devices (expires_at)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_trusted_devices TO postwave_app;

ALTER TABLE auth_trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_trusted_devices FORCE ROW LEVEL SECURITY;

-- Deliberately tenant-scoped ONLY: there is no pre-tenant resolver policy on
-- this table, unlike auth_sessions. Trust is consumed inside login's session
-- issuance, at which point the user and tenant have ALREADY been resolved by
-- the password/passkey/link check — so the read runs under app.tenant_id like
-- any other tenant table. A resolver policy here would let a caller probe
-- trust records before proving anything, so it is not granted.
DROP POLICY IF EXISTS tenant_isolation ON auth_trusted_devices;
CREATE POLICY tenant_isolation ON auth_trusted_devices
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-tenant opt-out. TRUE by default: the product owner approved device
-- trust, so a workspace has to turn it OFF deliberately. Honoured server-side
-- at BOTH issuance and consumption, so flipping it false immediately stops
-- already-issued records from satisfying MFA.
ALTER TABLE tenant_security_settings
    ADD COLUMN IF NOT EXISTS allow_trusted_devices boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tenant_security_settings.allow_trusted_devices IS
    'AUTH#48. When false, this workspace refuses to issue device-trust records AND refuses to let existing ones satisfy MFA. Default true because the feature is approved; a workspace running require_2fa_for_admins may still switch it off.';

COMMIT;
