-- 0148_subscriber_notes.sql
--
-- Operator-authored notes attached to a subscriber.
--
-- Use cases:
--   * support: "called in about a missing receipt 2025-04-12"
--   * sales:   "qualified at the conference, follow up on enterprise"
--   * ops:     "appears to be a competitor — flag before sends"
--
-- Notes are append-only from the operator's perspective (we don't
-- expose an UPDATE surface); the operator-facing affordance is
-- "add a note" or "delete a note", not "edit". This keeps the
-- audit trail honest.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_notes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL,
    subscriber_email citext NOT NULL,
    body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    author_user_id  uuid,
    author_email    citext,
    pinned          boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriber_notes_sub
    ON subscriber_notes (tenant_id, subscriber_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriber_notes_email
    ON subscriber_notes (tenant_id, subscriber_email, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_notes TO postwave_app;

ALTER TABLE subscriber_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriber_notes AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
