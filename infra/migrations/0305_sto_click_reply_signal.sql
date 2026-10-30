-- 0301_sto_click_reply_signal.sql
--
-- Include click + reply events in the send-time-optimization (STO)
-- signal (sto-click-reply-signal, P1).
--
-- Before this migration, send_time_opt.Compute() and LoadOpenPattern()
-- filter subscriber_events.event_type='opened' EXCLUSIVELY when
-- deriving the modal hour-of-week and the 7x24 heatmap. Opens are a
-- weak intent signal — Apple MPP / Gmail-proxy / SafeLinks fire
-- prefetches that look identical to a human open, so an "opens-only"
-- model is structurally biased toward bot prefetch windows even after
-- the bot_open_filter regex set.
--
-- Clicks and replies are much stronger intent: a click requires the
-- human to act on the message, and a reply requires the human to
-- compose a response. 2026 SOTA reflects this:
--
--   * Klaviyo Reinforcement-Learning STO weights opens + clicks +
--     placed-orders as separate engagement signals with learned
--     per-signal weights.
--   * Iterable Brand Affinity uses opens + clicks as the two-signal
--     foundation for affinity score.
--   * MoEngage Best Time to Send (BTS) uses opens + clicks + (for
--     web) browser views, learned per channel.
--
-- This migration:
--
--   1. Extends the subscriber_events.event_type CHECK constraint to
--      allow 'replied'. The 'opened' and 'clicked' values already
--      exist on the base table; 'replied' was missing despite the
--      campaign_replies table from migration 0087 — adding it lets
--      future ingest paths land reply events on the same engagement
--      log the STO pipeline reads from. Existing rows are unaffected
--      because we widen, not narrow, the vocabulary.
--
--   2. Adds three per-event-type weight columns to
--      tenant_send_settings — sto_signal_weight_open,
--      sto_signal_weight_click, sto_signal_weight_reply. Defaults
--      match the audit sketch (1, 3, 5): a reply is 5x stronger than
--      an open, a click is 3x stronger. Each tenant can re-tune via
--      the settings surface without a schema change (Klaviyo / Iterable
--      / MoEngage all surface per-signal weights as tenant-tunable knobs).
--
--   3. Adds CHECK constraints on the weight columns to keep them
--      sane (>= 0 AND <= 100) so a fat-fingered "1000" can't drown
--      out every other signal and crash downstream histogram
--      cardinality.
--
-- Operator note: the weights only affect the STO Compute() +
-- LoadOpenPattern() / LoadSegmentPattern() codepaths. The
-- subscriber_events writers (webhook ingest, /track click handler)
-- are unaffected.

BEGIN;

-- 1) Widen subscriber_events.event_type vocabulary to include
-- 'replied'. The base CHECK constraint was created inline in
-- migration 0013 with the auto-generated name
-- `subscriber_events_event_type_check`; drop + recreate to widen.
ALTER TABLE subscriber_events
    DROP CONSTRAINT IF EXISTS subscriber_events_event_type_check;

ALTER TABLE subscriber_events
    ADD CONSTRAINT subscriber_events_event_type_check
    CHECK (event_type IN
        ('opened','clicked','bounced','complained','unsubscribed','replied'));

-- 2) Per-event-type STO signal weights on the tenant_send_settings row
-- (created in migration 0299). The weights are integers in [0, 100];
-- 0 disables the signal entirely (mirroring the audit sketch's
-- "tenant can opt out of clicks if they're noisy for them").
ALTER TABLE tenant_send_settings
    ADD COLUMN IF NOT EXISTS sto_signal_weight_open  smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS sto_signal_weight_click smallint NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS sto_signal_weight_reply smallint NOT NULL DEFAULT 5;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_sto_weights_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_sto_weights_chk
            CHECK (
                sto_signal_weight_open  BETWEEN 0 AND 100
            AND sto_signal_weight_click BETWEEN 0 AND 100
            AND sto_signal_weight_reply BETWEEN 0 AND 100
            );
    END IF;
END$$;

COMMIT;
