-- 1882_transactional_email_outcomes.sql
--
-- Tell a transactional sender what happened to their message.
--
-- `transactional_emails` records what we ACCEPTED and handed to the provider:
-- status goes queued -> sending -> sent, and stops there forever. When the
-- message then hard-bounces or the recipient reports it as spam, the feedback
-- pipeline suppresses the address — correctly — and the sender's own record of
-- the message still says `sent`. `GET /api/v1/emails/{id}` reports a success
-- that did not happen.
--
-- The join already exists and is already used: `feedback.LookupTenantByESPMessageID`
-- matches `transactional_emails.provider_message_id` against the ESP's message
-- id to find the tenant. It resolves whose message it was and then throws away
-- WHICH message it was.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN. `to_addrs` is text[]: one row can be
-- addressed to several recipients, and a bounce is about ONE of them. Collapsing
-- that into a single status column would have to answer "what is the status of a
-- message where one of three recipients bounced", and every available answer is
-- a lie — `bounced` slanders two working addresses, `sent` hides a real failure.
-- One row per (message, recipient) is the shape the data actually has.
--
-- WHY NOT REUSE bounce_events. That table is keyed by ADDRESS and exists to
-- drive suppression: its question is "should we ever mail this person again".
-- This one's question is "what happened to the receipt I sent order #4131",
-- which is per-message and must survive the address later being un-suppressed.

BEGIN;

CREATE TABLE IF NOT EXISTS transactional_email_outcomes (
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email_id   uuid        NOT NULL REFERENCES transactional_emails(id) ON DELETE CASCADE,
    recipient  text        NOT NULL,
    -- Deliberately NOT the same vocabulary as transactional_emails.status.
    -- That column is about our submission; this is about the recipient's
    -- mailbox, and conflating them is how "sent" came to mean "delivered".
    outcome    text        NOT NULL,
    -- Why, in the provider's words, for the operator reading a support ticket.
    reason     text        NOT NULL DEFAULT '',
    esp        text        NOT NULL DEFAULT '',
    occurred_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, email_id, recipient, outcome),
    CONSTRAINT transactional_email_outcomes_outcome_check
        CHECK (outcome = ANY (ARRAY['delivered', 'bounced', 'complained', 'deferred'])),
    CONSTRAINT transactional_email_outcomes_recipient_len
        CHECK (char_length(recipient) BETWEEN 1 AND 320)
);

COMMENT ON TABLE transactional_email_outcomes IS
    'What happened to a transactional message AT THE RECIPIENT, keyed per '
    '(message, recipient) because to_addrs is an array and a bounce concerns '
    'one address. Distinct from transactional_emails.status, which describes '
    'our submission to the provider and cannot describe the mailbox.';

-- The read path is "everything that happened to this message"; the writer
-- arrives with an ESP message id and resolves the email first.
CREATE INDEX IF NOT EXISTS transactional_email_outcomes_email_idx
    ON transactional_email_outcomes (tenant_id, email_id);

-- provider_message_id is how feedback finds the message at all. Without this
-- every bounce webhook scans the table.
CREATE INDEX IF NOT EXISTS transactional_emails_provider_message_id_idx
    ON transactional_emails (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

ALTER TABLE transactional_email_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactional_email_outcomes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transactional_email_outcomes;
CREATE POLICY tenant_isolation ON transactional_email_outcomes
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON transactional_email_outcomes;
CREATE POLICY tenant_visible ON transactional_email_outcomes
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON transactional_email_outcomes TO postwave_app;

COMMIT;
