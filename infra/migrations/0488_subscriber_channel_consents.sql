-- 0488_subscriber_channel_consents.sql
--
-- SUB-042 — Per-channel consent on one profile.
--
-- Why this migration:
--   Consent today is scattered across surfaces: email marketing lives in the
--   subscribers consent vector (0318), SMS consent lives in the separate
--   sms_subscriptions table (0098) keyed on phone_e164, the status page has a
--   channel-agnostic status_subscribers table (0116), preference topics (0016)
--   model topic-level opt-in, and suppressions (0245) gate blocking rather than
--   consent. There is no single row that answers "what has THIS profile
--   consented to, per channel?" — which is what an operator needs when looking
--   at a contact and deciding whether email / SMS / push / WhatsApp / RCS can
--   be sent, under one shared frequency cap.
--
--   This migration creates a unified subscriber_channel_consents table keyed on
--   (tenant_id, subscriber_id, channel) consolidating all five channels into one
--   row per (profile, channel). It carries:
--     - status:            opted_in / opted_out / pending / unknown
--     - consent_timestamp: when the current status was recorded
--     - consent_source:    free-text origin (form, keyword, import, api, ...)
--     - frequency_cap_until: shared frequency cap — sends to this channel are
--                            held until this timestamp passes. NULL = no cap.
--     - email / phone_e164: denormalised identifiers for send-time join
--                           efficiency (avoid a subscribers re-join per send).
--
--   Backfill: one 'email' row per subscriber (opted_in iff the 0318
--   consent_email_marketing_at vector is set), and one 'sms' row per
--   sms_subscriptions row, mapping its status into the unified vocabulary.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- subscriber_channel_consents.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_channel_consents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- The five channels a single profile can be reached on. Pinned via CHECK so
    -- a drifting client cannot land an unknown channel.
    channel            text NOT NULL CHECK (channel IN (
                           'email', 'sms', 'push', 'whatsapp', 'rcs'
                       )),
    -- Unified consent vocabulary across all channels. 'unknown' is the
    -- never-recorded default; 'pending' is the double-opt-in interstitial.
    status             text NOT NULL DEFAULT 'unknown' CHECK (status IN (
                           'opted_in', 'opted_out', 'pending', 'unknown'
                       )),
    consent_timestamp  timestamptz,
    consent_source     text NOT NULL DEFAULT 'unknown',
    -- Shared frequency cap: sends to this channel are held until this passes.
    -- NULL = no active cap.
    frequency_cap_until timestamptz,
    -- Denormalised identifiers for send-time joins. Kept nullable: a channel
    -- row may exist before the identifier is known.
    email              citext,
    phone_e164         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- One row per (profile, channel) — the whole point of the unification.
    UNIQUE (tenant_id, subscriber_id, channel)
);

COMMENT ON TABLE subscriber_channel_consents IS
    'SUB-042 unified per-channel consent: one row per (profile, channel) consolidating email/sms/push/whatsapp/rcs consent + a shared frequency cap.';

-- "All channel consents for subscriber X" — the dominant read shape (detail
-- slideover).
CREATE INDEX IF NOT EXISTS subscriber_channel_consents_subscriber_idx
    ON subscriber_channel_consents (tenant_id, subscriber_id);

-- "Everyone currently opted in on channel X" — the send-time / segment shape.
CREATE INDEX IF NOT EXISTS subscriber_channel_consents_channel_status_idx
    ON subscriber_channel_consents (tenant_id, channel, status);

CREATE TRIGGER subscriber_channel_consents_set_updated_at
    BEFORE UPDATE ON subscriber_channel_consents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill 1: one 'email' row per subscriber. opted_in iff the 0318 vector is
-- set; consent_timestamp mirrors the vector grant time.
INSERT INTO subscriber_channel_consents
    (tenant_id, subscriber_id, channel, status, consent_timestamp, consent_source, email, phone_e164)
SELECT s.tenant_id,
       s.id,
       'email',
       CASE WHEN s.consent_email_marketing_at IS NOT NULL THEN 'opted_in' ELSE 'unknown' END,
       s.consent_email_marketing_at,
       'backfill',
       s.email,
       s.phone_e164
  FROM subscribers s
 WHERE NOT EXISTS (
       SELECT 1 FROM subscriber_channel_consents c
        WHERE c.tenant_id = s.tenant_id
          AND c.subscriber_id = s.id
          AND c.channel = 'email'
 );

-- Backfill 2: one 'sms' row per subscriber that has a matching
-- sms_subscriptions row (joined on phone_e164). Maps the sms status vocabulary
-- (pending/opted_in/opted_out) into the unified vocabulary (identical here).
INSERT INTO subscriber_channel_consents
    (tenant_id, subscriber_id, channel, status, consent_timestamp, consent_source, email, phone_e164)
SELECT DISTINCT ON (s.tenant_id, s.id)
       s.tenant_id,
       s.id,
       'sms',
       ss.status,
       ss.consent_at,
       ss.consent_source,
       s.email,
       ss.phone_e164
  FROM subscribers s
  JOIN sms_subscriptions ss
    ON ss.tenant_id = s.tenant_id
   AND ss.phone_e164 = s.phone_e164
 WHERE s.phone_e164 IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM subscriber_channel_consents c
        WHERE c.tenant_id = s.tenant_id
          AND c.subscriber_id = s.id
          AND c.channel = 'sms'
 )
 ORDER BY s.tenant_id, s.id, ss.updated_at DESC;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_channel_consents TO postwave_app;

ALTER TABLE subscriber_channel_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_channel_consents FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_channel_consents
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_channel_consents
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
