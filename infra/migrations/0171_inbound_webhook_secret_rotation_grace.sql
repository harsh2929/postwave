-- 0171_inbound_webhook_secret_rotation_grace.sql
--
-- Closes webhook-rotation CRITICAL #2 + #3:
--
--   C2 (no grace window): RotateSecret previously did a hard cut —
--   the moment the new secret was written, every in-flight retry
--   from the upstream sender signed under the old secret started
--   failing with 401. Provider retry policies vary (Stripe backs
--   off for hours; GitHub retries 3 times then drops) so a
--   rotation could lose data with no signal.
--
--   C3 (envelope no-op): RotateSecret updated only the legacy
--   `secret` column, not `secret_envelope`. For endpoints created
--   AFTER the envelope-encryption rollout (where secret =
--   'envelope:do-not-use'), the rotation was a silent no-op — the
--   verifier kept reading the old secret_envelope and accepting
--   signatures from the old secret. Operators saw a new secret in
--   the API response but the live ingest path didn't change.
--
-- Schema:
--   * Add `secondary_secret` + `secondary_secret_envelope` for the
--     dual-verify window.
--   * Add `secondary_expires_at` so a janitor can clear stale
--     secondaries after their grace window passes.
--   * Backfill is unnecessary — every existing row has both
--     secondary fields NULL, which the verifier treats as "no
--     grace window active."

BEGIN;

ALTER TABLE inbound_webhook_endpoints
    ADD COLUMN IF NOT EXISTS secondary_secret          text,
    ADD COLUMN IF NOT EXISTS secondary_secret_envelope bytea,
    ADD COLUMN IF NOT EXISTS secondary_expires_at      timestamptz;

CREATE INDEX IF NOT EXISTS inbound_webhook_endpoints_secondary_sweep_idx
    ON inbound_webhook_endpoints (secondary_expires_at)
    WHERE secondary_expires_at IS NOT NULL;

COMMIT;
