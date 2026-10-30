-- 1816_cli_device_grant_kind.sql
--
-- AUTH#52 — let an RFC 8628 device grant issue a BROWSER SESSION, not only a
-- CLI API key.
--
-- The device-grant primitive (1629) was built for headless CLI login, so its
-- token exchange unconditionally minted a long-lived API key. Everything
-- needed to approve a browser sign-in from a phone already existed on the
-- client side — QR recognition, the approval screen, typed-code entry — but
-- the server had no way to express "this grant should end in a cookie".
--
-- grant_kind is that expression, and nothing else:
--
--   'api_key' (DEFAULT) — the existing behaviour, byte for byte. Every row
--                         written before this migration reads back as
--                         'api_key', so the CLI flow is untouched.
--   'session'           — the token exchange issues a session cookie for the
--                         approving user instead of minting a key.
--
-- The CHECK constraint is the vocabulary backstop; the handler validates too.
-- No RLS change: the policy from 1732/1733 keys on device_code_hash /
-- user_code / tenant_id, none of which this column affects. The grant is
-- still one-shot, still 10-minute-TTL, still bound to the approving user's
-- tenant at approval time.
--
-- rollback-strategy: additive and defaulted, so a rollback is a plain
-- `ALTER TABLE cli_device_grants DROP COLUMN IF EXISTS grant_kind;` — no
-- backfill to undo and no behaviour to restore, because rows default to the
-- pre-existing 'api_key' semantics. Deploy the column before the code that
-- reads it; older API instances ignore the column entirely.

BEGIN;

ALTER TABLE cli_device_grants
    ADD COLUMN IF NOT EXISTS grant_kind text NOT NULL DEFAULT 'api_key';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname  = 'cli_device_grants_grant_kind_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_grant_kind_check
            CHECK (grant_kind IN ('api_key', 'session'));
    END IF;
END
$$;

COMMIT;
