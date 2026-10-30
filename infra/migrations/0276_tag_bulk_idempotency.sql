-- 0276_tag_bulk_idempotency.sql
--
-- Tags refinement 5/12 — bulk apply/unapply endpoint persistence.
--
-- Caches the response shape of POST /api/v1/tags/{id}/apply and
-- /unapply keyed by (tenant_id, tag_id, idempotency_key) so a
-- retried bulk call returns the original {applied,skipped} payload
-- instead of double-counting or partially re-applying. Rows expire
-- after 24h via the expires_at column; a sweeper can vacuum them in
-- a follow-up.
--
-- The cache is intentionally small: it stores the integer counters
-- (applied, skipped) plus a SHA-256 hash of the (subscriber_ids,
-- tag_id) payload so a replay with a *different* body returns the
-- same 422 mismatch surface that the canonical idempotency
-- middleware exposes.

BEGIN;

CREATE TABLE IF NOT EXISTS tag_bulk_idempotency (
    tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tag_id           uuid        NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    idempotency_key  text        NOT NULL,
    request_hash     text        NOT NULL,
    op               text        NOT NULL CHECK (op IN ('apply', 'unapply')),
    applied          int         NOT NULL DEFAULT 0,
    skipped          int         NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    PRIMARY KEY (tenant_id, tag_id, idempotency_key),
    CHECK (length(idempotency_key) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS tag_bulk_idempotency_expires_idx
    ON tag_bulk_idempotency (expires_at);

GRANT SELECT, INSERT, DELETE ON tag_bulk_idempotency TO postwave_app;

-- Widen the tag_history.action CHECK to admit the batched bulk events
-- emitted by /api/v1/tags/{id}/apply and /unapply. One row per call
-- (rather than N per subscriber) keeps the audit log scannable.
--
-- tag_history is created later (0292); on an in-order fresh replay the
-- table does not exist yet, so guard the widen on its presence. Fresh DBs
-- get the widened CHECK directly from 0292's CREATE TABLE; existing DBs
-- (where the table predates this migration) get it widened here.
DO $$
BEGIN
    IF to_regclass('public.tag_history') IS NOT NULL THEN
        ALTER TABLE tag_history DROP CONSTRAINT IF EXISTS tag_history_action_check;
        ALTER TABLE tag_history ADD  CONSTRAINT tag_history_action_check
            CHECK (action IN (
                'tag_added',
                'tag_removed',
                'tag_created',
                'tag_updated',
                'tag_archived',
                'tag_restored',
                'tag_deleted',
                'tag_renamed',
                'tag_merged',
                'tag_redacted',
                'bulk_applied',
                'bulk_unapplied'
            ));
    END IF;
END
$$;

ALTER TABLE tag_bulk_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_bulk_idempotency FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tag_bulk_idempotency;
CREATE POLICY tenant_isolation ON tag_bulk_idempotency
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON tag_bulk_idempotency;
CREATE POLICY tenant_visible ON tag_bulk_idempotency
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
