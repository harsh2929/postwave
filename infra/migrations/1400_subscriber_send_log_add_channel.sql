-- 1400_subscriber_send_log_add_channel.sql
--
-- SUB-133: cross-channel frequency cap — a single cap evaluated per channel
-- across email + SMS + push.
--
-- Before this migration frequency tracking was channel-agnostic:
--   * subscriber_send_log (migration 0260) had no channel column, so every
--     dispatch — regardless of channel — counted toward the same cap.
--   * frequency_cap_rules (migration 0260) applied uniformly across channels.
--
-- This migration is purely ADDITIVE and backward-compatible:
--
--   1. subscriber_send_log gains a `channel text NOT NULL DEFAULT 'email'`
--      column so each logged send records which channel it left on. Existing
--      rows backfill to 'email' (the only channel that historically wrote to
--      the log), preserving the meaning of every pre-existing counter row.
--
--   2. frequency_cap_rules gains a `channels text[] NOT NULL DEFAULT
--      ARRAY['email']::text[]` column so a rule can scope to one or more
--      channels. The default matches the migration 0260 design note ("leave
--      room to add a `channels text[]` column later ... default to {'email'}")
--      so every existing rule keeps its historic email-only semantics.
--
-- The frequency filter (apps/api/internal/frequency/frequency.go) reads these
-- columns: FilterAudienceForChannel(channel) counts only subscriber_send_log
-- rows whose channel matches, and evaluates only rules that target that
-- channel (or have an empty/NULL channels set, which means "all channels").
--
-- A new lookup index covers the channel-scoped count query so the per-channel
-- filter stays a single index scan, mirroring the existing
-- subscriber_send_log_lookup_idx.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS keep the
-- migration replay-safe in the dev-shell-bootstrap flow.

BEGIN;

-- 1. subscriber_send_log.channel ----------------------------------------------
ALTER TABLE subscriber_send_log
    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Channel-scoped lookup: (tenant, channel, subscriber, sent_at DESC) so the
-- per-channel cap query plans as a single index scan.
CREATE INDEX IF NOT EXISTS subscriber_send_log_channel_lookup_idx
    ON subscriber_send_log (tenant_id, channel, subscriber_email, sent_at DESC);

-- 2. frequency_cap_rules.channels ---------------------------------------------
-- Default ARRAY['email'] keeps every existing rule email-only (back-compat).
-- An empty array OR NULL is interpreted by the filter as "applies to all
-- channels", but the default is the conservative email-only scope.
ALTER TABLE frequency_cap_rules
    ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT ARRAY['email']::text[];

COMMIT;
