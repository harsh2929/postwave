-- 1892_auth_sessions_mfa_freshness.sql
--
-- When the possession proof was given, not merely whether.
--
-- `auth_sessions.mfa_satisfied` is a boolean set once at login. The codebase
-- already states the consequence, in internal/auth/recovery_codes.go: it "is set
-- once at login and never expires, so a borrowed post-MFA session could
-- otherwise mint codes forever". That comment is attached to ONE endpoint,
-- which solved it locally by demanding a fresh TOTP inline. Every other
-- sensitive action — rotating an API key, exporting every subscriber, deleting
-- a list — is still guarded by a flag that has been true since breakfast.
--
-- Step-up is impossible to express without this column: "prove it again" needs
-- a clock, and the boolean has none. That is why the one place that needed it
-- had to bypass the session flag entirely rather than ask it a question.
--
-- NULLABLE and un-backfilled. A session that satisfied MFA before this column
-- existed has an unknown proof time, and inventing one — `issued_at`, `now()` —
-- would grant freshness that was never demonstrated. NULL means "no fresh proof
-- on record", which for a step-up gate is the same answer as "too old": both
-- prompt. An honest unknown that fails closed.

BEGIN;

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS mfa_satisfied_at timestamptz;

COMMENT ON COLUMN auth_sessions.mfa_satisfied_at IS
    'When this session last demonstrated a possession factor. NULL means no '
    'fresh proof is on record — including for sessions predating this column — '
    'which every step-up policy treats as "prompt", never as "allow".';

-- The gate reads it per request, always alongside the session id it already
-- has, so no index is added: the primary key lookup already covers it and an
-- index on a column read only by id would be pure write cost.

COMMIT;
