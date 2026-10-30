-- KLV-10 fix: make the auto spam-assessment on the inbound mirror idempotent.
--
-- MirrorInbound dedups the conversation + message on provider re-delivery, but
-- the auto spam-assessment was re-inserted each time, accumulating duplicate
-- rows for the same message. A partial unique index lets the auto path upsert
-- one assessment per (tenant, message) via ON CONFLICT DO NOTHING. Operator-
-- supplied, message-less assessments (message_id NULL) are unaffected — Postgres
-- treats NULLs as distinct and the partial predicate excludes them entirely.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS support_spam_assessments_message_unique
    ON support_spam_assessments (tenant_id, message_id)
    WHERE message_id IS NOT NULL;

COMMIT;
