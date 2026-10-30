-- 0388_sms_broadcasts.sql
--
-- SMS broadcasts (full-surface wiring roadmap: "SMS broadcasts — the
-- composer is the missing 20%").
--
-- sms_broadcasts is the operator-facing composer object. Unlike the
-- single-list sms_campaigns row from 0098, a broadcast expresses its
-- audience the way email campaigns do (audience_list_id /
-- audience_segment_id on campaigns) extended to the SMS shape:
--
--   * list_ids   uuid[]  — one or more sms_lists; the audience is the
--                          union of opted-in sms_subscriptions rows.
--   * segment_id uuid    — a saved segment (segments / the
--                          segment_subscribers materialised cache from
--                          0279), linked to SMS consent through
--                          sms_subscriptions.subscriber_email.
--   * tag        text    — subscribers.tags membership, linked to SMS
--                          consent the same way.
--
-- Exactly one audience dimension is set per broadcast (enforced by the
-- API; the columns are independent so drafts can be edited freely).
--
-- Execution rides the EXISTING send engine: when a broadcast is sent,
-- the API creates a shadow sms_campaigns row (campaign_id below) and
-- enqueues resolved recipients into sms_campaign_recipients — the 0098
-- worker/gate path (quiet-hours hold, suppression skip, consent check,
-- throttle) then drains them. No parallel sender exists.
--
-- sent_count / failed_count / held_count are denormalised progress
-- counters refreshed from sms_campaign_recipients by the API
-- (GET .../progress) and the worker sweep; "held" means queued rows
-- deferred by the quiet-hours gate (error_code = 'quiet_hours').
--
-- RLS: ENABLE + FORCE with the canonical permissive tenant_visible
-- USING/WITH CHECK pair on the NULLIF GUC idiom (a raw cast crashes on
-- an unset app.tenant_id). A permissive sms_worker policy mirrors
-- 0098's sms_worker_campaigns so the cross-tenant queue worker can
-- sweep due scheduled broadcasts and finalize sending ones. NOTE: no
-- RESTRICTIVE tenant policy here — a restrictive policy would AND with
-- (and therefore break) the worker policy, which runs without a tenant
-- GUC.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_broadcasts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sender_profile_id  uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    -- Shadow send-engine campaign; set when the broadcast starts
    -- sending. Also the send-idempotency anchor: recipients are unique
    -- per (tenant_id, campaign_id, phone_e164) in
    -- sms_campaign_recipients, so re-enqueueing the same broadcast can
    -- never double-queue a phone.
    campaign_id        uuid REFERENCES sms_campaigns(id) ON DELETE SET NULL,
    name               text NOT NULL,
    body               text NOT NULL DEFAULT '',
    list_ids           uuid[] NOT NULL DEFAULT '{}'::uuid[],
    segment_id         uuid REFERENCES segments(id) ON DELETE SET NULL,
    tag                text,
    status             text NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'scheduled', 'sending', 'sent', 'cancelled'
                       )),
    scheduled_at       timestamptz,
    sent_count         int NOT NULL DEFAULT 0,
    failed_count       int NOT NULL DEFAULT 0,
    held_count         int NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Operator list view: newest first per tenant, filterable by status.
CREATE INDEX IF NOT EXISTS sms_broadcasts_tenant_status_idx
    ON sms_broadcasts (tenant_id, status, created_at DESC);

-- Worker sweep: "scheduled broadcasts that are due" and "sending
-- broadcasts to finalize". Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS sms_broadcasts_due_idx
    ON sms_broadcasts (status, scheduled_at)
    WHERE status IN ('scheduled', 'sending');

GRANT SELECT, INSERT, UPDATE, DELETE ON sms_broadcasts TO postwave_app;

ALTER TABLE sms_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_broadcasts FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_broadcasts' AND policyname = 'tenant_visible'
    ) THEN
        CREATE POLICY tenant_visible ON sms_broadcasts
            AS PERMISSIVE FOR ALL TO postwave_app
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_broadcasts' AND policyname = 'sms_worker_broadcasts'
    ) THEN
        CREATE POLICY sms_worker_broadcasts ON sms_broadcasts
            AS PERMISSIVE FOR ALL TO postwave_app
            USING (current_setting('app.sms_worker', true) = 'true')
            WITH CHECK (current_setting('app.sms_worker', true) = 'true');
    END IF;
END;
$$;

COMMIT;
