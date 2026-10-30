-- 1861_sms_consent_vector_backfill.sql
--
-- Republish existing SMS opt-ins onto subscribers.consent_sms_marketing_at.
--
-- SMS consent has always been RECORDED in sms_subscriptions, which is what the
-- SMS broadcast audience reads. But every ACTIVATION path reads the
-- subscriber-level vector column instead: internal/segments compiles the SMS
-- channel gate to `consent_sms_marketing_at IS NOT NULL`, and
-- internal/omnichannel routes sms, whatsapp AND rcs through that same gate. No
-- code path ever wrote the column — its only writers were erasure (which sets
-- NULL) and the subscriber-merge intersection.
--
-- The result was a total, silent failure: every omnichannel phone-channel send
-- resolved zero recipients while the opt-in rows sat in sms_subscriptions.
--
-- internal/sms.RecordConsent now projects onto the column on every consent
-- write. This backfills the people who opted in before that existed; without it
-- they stay invisible to activation until they happen to re-consent.
--
-- The eligibility rule is the SAME one the projection applies, deliberately
-- duplicated here only because a migration cannot call Go: consent is present
-- iff some subscription is opted in on a phone that is not actively suppressed.
-- A tenant-wide suppression (a STOP keyword) outranks any surviving opt-in row,
-- which matters because RecordConsent's global-STOP path writes the suppression
-- WITHOUT marking any subscription opted_out.
--
-- Grants only. COALESCE keeps an existing timestamp, and the IS NULL guard makes
-- a re-run a no-op — this must never move a consent date, because that date is
-- the evidence in a consent receipt. It also never clears: a subscriber whose
-- vector is set but who has no eligible subscription is left alone rather than
-- silently de-consented by a migration, since the column is also the email-era
-- record for people who arrived by other paths.
--
-- The timestamp is the EARLIEST evidence of opt-in (min of consent_at, falling
-- back to row creation), not now(). Stamping now() would claim consent was
-- given at deploy time, which is false and would misdate every receipt.

-- BATCHED. `subscribers` carries 18 triggers, so a single UPDATE across the
-- whole table holds row locks on every matched row for the duration and runs
-- every trigger inside one transaction. On a large base that is a long write
-- lock on the busiest table in the schema. The loop commits per batch, so an
-- interrupted run leaves consistent partial progress and re-running resumes —
-- the `IS NULL` guard makes each batch idempotent.
DO $$
DECLARE
    v_batch integer := 5000;
    v_rows  integer;
BEGIN
    LOOP
        UPDATE subscribers s
           SET consent_sms_marketing_at = c.first_consent_at,
               updated_at = now()
          FROM (
            SELECT ss.tenant_id,
                   ss.subscriber_email,
                   min(COALESCE(ss.consent_at, ss.created_at)) AS first_consent_at
              FROM sms_subscriptions ss
             WHERE ss.status = 'opted_in'
               AND ss.subscriber_email IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                     FROM sms_suppressions p
                    WHERE p.tenant_id = ss.tenant_id
                      AND p.phone_e164 = ss.phone_e164
                      AND (p.expires_at IS NULL OR p.expires_at > now()))
             GROUP BY ss.tenant_id, ss.subscriber_email
          ) c
         WHERE s.tenant_id = c.tenant_id
           AND s.email = c.subscriber_email
           AND s.consent_sms_marketing_at IS NULL
           AND s.id IN (
               SELECT s2.id
                 FROM subscribers s2
                WHERE s2.tenant_id = c.tenant_id
                  AND s2.email = c.subscriber_email
                  AND s2.consent_sms_marketing_at IS NULL
                LIMIT v_batch);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        EXIT WHEN v_rows = 0;
        COMMIT;
    END LOOP;
END $$;

-- The projection reads sms_subscriptions by (tenant_id, subscriber_email) on
-- every consent write, which the existing (tenant_id, list_id, phone_e164)
-- unique index does not serve.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_subscriptions_tenant_email_idx
    ON sms_subscriptions (tenant_id, subscriber_email)
    WHERE subscriber_email IS NOT NULL;

-- 0318 added this column with the comment "Awaiting SMS writer dual-write" and
-- collapsed the SMS category out of its consent_events trigger, noting that SMS
-- opt-in "is recorded as a separate sms_consent_events row today". The writer it
-- was waiting for is the projection added to internal/sms.RecordConsent in this
-- change. The comment is no longer true and would otherwise read as a standing
-- to-do for work that is done.
COMMENT ON COLUMN subscribers.consent_sms_marketing_at IS
    'State-of-record for SMS marketing consent. NULL = no recorded grant. '
    'Projected by internal/sms.RecordConsent from sms_subscriptions + '
    'sms_suppressions on every consent write: present iff some subscription is '
    'opted in on a phone that is not actively suppressed. Unlike the email '
    'columns this is NOT maintained by the consent_events trigger — SMS '
    'evidence lives in sms_consent_events.';
