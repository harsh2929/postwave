-- 0029_subscriber_event_bounce_type.sql
--
-- Adds bounce_type and country columns to subscriber_events to support the
-- analytics package's bounce categorization and geography report. Both are
-- nullable; existing rows remain readable as 'unknown'.
--
-- bounce_type semantics:
--   'hard'       permanent failure (5xx SMTP, mailbox does not exist)
--   'soft'       transient failure (4xx SMTP, mailbox full, greylisted)
--   'spam_trap'  recipient is a known spam trap address
--   NULL         unclassified (older rows or non-bounce events)

BEGIN;

ALTER TABLE subscriber_events
    ADD COLUMN bounce_type text
        CHECK (bounce_type IN ('hard','soft','spam_trap')),
    ADD COLUMN country text;

CREATE INDEX subscriber_events_country_idx
    ON subscriber_events (tenant_id, campaign_id, country)
    WHERE country IS NOT NULL;

COMMIT;
