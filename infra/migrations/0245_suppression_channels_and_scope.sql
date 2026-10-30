-- 0245_suppression_channels_and_scope.sql
--
-- GAP-LS-005 / GAP-LS-006 / GAP-LS-013: per-channel + per-scope +
-- per-match-kind suppression columns on the two email suppression
-- tables (X1 + Mailchimp-parity). The legacy `suppressions` (0060)
-- table is being retired by the converger so we don't widen it here.
--
-- Why these three columns:
--
--   - channel (email/sms/push/any) closes Braze Subscription-Groups
--     and Customer.io Q2 channel-preferences parity. Today every
--     suppression blocks all channels because the column doesn't
--     exist. Default 'email' preserves existing rows' behaviour
--     under the new send-time AND channel = 'email' OR channel =
--     'any' predicate.
--
--   - scope (marketing/transactional/all) closes HubSpot
--     Transactional + Marketo Operational parity. Default 'marketing'
--     so that pre-existing suppressions stop blocking transactional
--     sends as soon as the sendloop fork lands.
--
--   - match_kind (email/domain) closes GAP-LS-013 (block
--     @competitor.com style operator-pain entries). Default 'email'
--     so existing rows continue to match by full address. Domain
--     entries are written with email='@competitor.com' (or just
--     'competitor.com'; the matcher lowercases + strips '@').
--
-- rollback-strategy: expand-contract — columns are additive with
-- safe defaults; the send-loop filter widens its predicate AFTER this
-- migration lands. Dropping the columns later requires removing the
-- send-loop predicate first.

BEGIN;

-- X1: subscriber_suppressions ----------------------------------------------
ALTER TABLE subscriber_suppressions
    ADD COLUMN IF NOT EXISTS channel    text NOT NULL DEFAULT 'email',
    ADD COLUMN IF NOT EXISTS scope      text NOT NULL DEFAULT 'marketing',
    ADD COLUMN IF NOT EXISTS match_kind text NOT NULL DEFAULT 'email';

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_channel_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_channel_check
        CHECK (channel IN ('email','sms','push','any'));

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_scope_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_scope_check
        CHECK (scope IN ('marketing','transactional','all'));

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_match_kind_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_match_kind_check
        CHECK (match_kind IN ('email','domain'));

-- Send-loop hot path: (tenant_id, channel, scope, email) — the
-- predicate the X1 read uses after this lands. Partial because most
-- rows have channel='email' and scope='marketing' (covered by the
-- existing tenant_email index); this targets cross-channel /
-- transactional / domain queries.
CREATE INDEX IF NOT EXISTS subscriber_suppressions_chan_scope_email_idx
    ON subscriber_suppressions (tenant_id, channel, scope, email);

CREATE INDEX IF NOT EXISTS subscriber_suppressions_domain_idx
    ON subscriber_suppressions (tenant_id, email)
    WHERE match_kind = 'domain';

-- Mailchimp-parity: email_suppressions -------------------------------------
ALTER TABLE email_suppressions
    ADD COLUMN IF NOT EXISTS channel    text NOT NULL DEFAULT 'email',
    ADD COLUMN IF NOT EXISTS scope      text NOT NULL DEFAULT 'marketing',
    ADD COLUMN IF NOT EXISTS match_kind text NOT NULL DEFAULT 'email';

ALTER TABLE email_suppressions
    DROP CONSTRAINT IF EXISTS email_suppressions_channel_check;
ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_channel_check
        CHECK (channel IN ('email','sms','push','any'));

ALTER TABLE email_suppressions
    DROP CONSTRAINT IF EXISTS email_suppressions_scope_check;
ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_scope_check
        CHECK (scope IN ('marketing','transactional','all'));

ALTER TABLE email_suppressions
    DROP CONSTRAINT IF EXISTS email_suppressions_match_kind_check;
ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_match_kind_check
        CHECK (match_kind IN ('email','domain'));

CREATE INDEX IF NOT EXISTS email_suppressions_chan_scope_email_idx
    ON email_suppressions (tenant_id, channel, scope, email);

CREATE INDEX IF NOT EXISTS email_suppressions_domain_idx
    ON email_suppressions (tenant_id, email)
    WHERE match_kind = 'domain';

COMMIT;
