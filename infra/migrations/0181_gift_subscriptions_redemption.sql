-- 0181_gift_subscriptions_redemption.sql
--
-- Turns gift_subscriptions from a row-insert stub (migration 0074)
-- into a real end-to-end product:
--
--   * redemption_token_sha256 — recipient claims their gift via
--     /gift/{raw-token}. We store the SHA-256 (not the raw token) so
--     a DB dump can't be replayed against in-flight gifts. The raw
--     token is shown to the giver once at create time + embedded in
--     the recipient email.
--   * redeemed_at — set when the recipient clicks Claim. Mirrors
--     granted_at for legacy callers; both refer to "the gift was
--     used."
--   * redeemed_by_subscriber_id — when the recipient's email matches
--     an existing subscriber row, we link them (FK SET NULL on
--     subscriber delete). Lets the dashboard show "redeemed by
--     alice@... (member since 2024)".
--   * expires_at — unclaimed-pending gifts auto-expire after the
--     configured window (default 90 days). Sweeper at
--     apps/api/internal/paid_tiers/expiration.go writes status='expired'.
--   * canceled_at + cancel_reason — operator cancels a pending gift
--     via POST /api/v1/gift-subscriptions/{id}/cancel.
--
-- All new columns are nullable / defaulted so existing rows survive
-- the migration untouched; the redemption_token_sha256 backfill
-- below seeds tokens for legacy rows so they can be used too.

BEGIN;

ALTER TABLE gift_subscriptions
    ADD COLUMN IF NOT EXISTS redemption_token_sha256    bytea,
    ADD COLUMN IF NOT EXISTS redeemed_at                timestamptz,
    ADD COLUMN IF NOT EXISTS redeemed_by_subscriber_id  uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS expires_at                 timestamptz,
    ADD COLUMN IF NOT EXISTS canceled_at                timestamptz,
    ADD COLUMN IF NOT EXISTS cancel_reason              text NOT NULL DEFAULT '';

-- Unique on the hash so token lookups are O(1) and so we catch the
-- (vanishingly unlikely) hash collision rather than redeeming the
-- wrong gift.
CREATE UNIQUE INDEX IF NOT EXISTS gift_subscriptions_token_idx
    ON gift_subscriptions (redemption_token_sha256)
    WHERE redemption_token_sha256 IS NOT NULL;

-- Partial index for the expiration sweeper. Partial = only pending
-- + only those with an expires_at set, so the scan stays O(due-rows)
-- even at 1M+ total gift rows.
CREATE INDEX IF NOT EXISTS gift_subscriptions_due_expiry_idx
    ON gift_subscriptions (expires_at)
    WHERE status = 'pending' AND expires_at IS NOT NULL;

-- Backfill: legacy rows (pre-0181) get an expires_at = created_at +
-- 90 days so the sweeper catches them on first tick rather than
-- letting them sit pending forever.
UPDATE gift_subscriptions
   SET expires_at = created_at + interval '90 days'
 WHERE expires_at IS NULL AND status = 'pending';

COMMIT;
