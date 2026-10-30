-- 0039_webhooks_secret_envelope.sql
--
-- Adds an envelope-encrypted copy of the webhook signing secret.
--
-- Why: 0017_webhooks.sql stored only secret_hash, mirroring how Stripe
-- and GitHub work — secrets are visible exactly once at create time.
-- That choice makes the database breach-resistant (a dump can't forge
-- webhooks) but it also means the gateway itself can't sign deliveries,
-- because there's nothing to recover. The Test endpoint at the time of
-- 0017 went out unsigned for the same reason.
--
-- Postwave runs with a KEK already (for sending provisioning), so we
-- can do strictly better than Stripe: keep secret_hash AS-IS for breach
-- resistance, AND store secret_envelope so the dispatcher can sign.
-- An attacker who lifts the DB still has nothing useful — the envelope
-- is meaningless without the KEK.
--
-- secret_envelope is nullable for legacy rows. The dispatcher's signing
-- path treats NULL as "deliver unsigned" (same behaviour as the V1 Test
-- endpoint) so existing webhooks don't break; the admin UI surfaces a
-- "rotate to upgrade signing" prompt for those rows. New Creates always
-- write both columns.

BEGIN;

ALTER TABLE webhooks
    ADD COLUMN IF NOT EXISTS secret_envelope bytea;

COMMIT;
