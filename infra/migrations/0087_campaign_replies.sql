-- 0087_campaign_replies.sql
--
-- Reply tracking — replaces the (clicks - unsubscribes) proxy used by the
-- A/B winner picker with real reply counts. Inbound provider webhooks
-- (Postmark, Mailgun, SES) classify and persist each subscriber reply
-- here so EvaluateWinner can aggregate them per-campaign.
--
-- Design notes:
--   * recipient_email is citext (case-insensitive equality vs subscribers).
--   * campaign_id / subscriber_id are nullable: replies that arrive with no
--     resolvable In-Reply-To header AND no VERP tag AND no subscriber-by-
--     from-address fallback land with NULL campaign_id for manual review.
--   * Idempotent on (tenant_id, source, raw_message_id): a duplicate
--     provider re-delivery collapses via the partial unique index.
--   * Append-only — rows are mutated only via LinkSubscriber for
--     retroactive campaign/subscriber resolution, never deleted.
--   * RLS mirrors every other tenant-scoped table: a permissive policy
--     keyed on app.tenant_id GUC set by db.WithTenant.

CREATE TABLE IF NOT EXISTS campaign_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid,                          -- NULL if reply couldn't be matched
  subscriber_id uuid,                        -- NULL if subscriber not in our system
  recipient_email citext NOT NULL,           -- the address that replied
  in_reply_to text,                          -- Message-ID being replied to
  subject text,
  body_snippet text,                         -- first ~500 chars of plaintext
  raw_message_id text,                       -- the inbound provider's message id
  source text NOT NULL,                      -- 'postmark' | 'mailgun' | 'ses-inbound' | 'imap' | 'manual'
  received_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_campaign_replies_campaign ON campaign_replies(tenant_id, campaign_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_replies_subscriber ON campaign_replies(tenant_id, subscriber_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_replies_msgid ON campaign_replies(tenant_id, source, raw_message_id) WHERE raw_message_id IS NOT NULL;

ALTER TABLE campaign_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON campaign_replies;
CREATE POLICY tenant_visible ON campaign_replies AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
