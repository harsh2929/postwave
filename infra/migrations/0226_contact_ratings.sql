-- 0226_contact_ratings.sql
--
-- Mailchimp-parity contact rating + history.
--
-- 1. subscribers.rating  — SMALLINT NULL, 1..5 stars; NULL = unrated.
-- 2. contact_history_events — append-only timeline of subscriber
--    changes (rating.changed, list.added, list.removed, note.added,
--    etc.). One JSONB payload column so the kind-specific shape can
--    evolve without migrations.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS rating SMALLINT NULL;

ALTER TABLE subscribers
    DROP CONSTRAINT IF EXISTS subscribers_rating_range_check;
ALTER TABLE subscribers
    ADD CONSTRAINT subscribers_rating_range_check
        CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));

CREATE INDEX IF NOT EXISTS subscribers_tenant_rating_idx
    ON subscribers (tenant_id, rating)
    WHERE rating IS NOT NULL;

CREATE TABLE contact_history_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    kind          text NOT NULL,
    at            timestamptz NOT NULL DEFAULT now(),
    payload       jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX contact_history_events_tenant_sub_at_idx
    ON contact_history_events (tenant_id, subscriber_id, at DESC, id DESC);

CREATE INDEX contact_history_events_tenant_kind_at_idx
    ON contact_history_events (tenant_id, kind, at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_history_events TO postwave_app;

ALTER TABLE contact_history_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_history_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_history_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON contact_history_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
