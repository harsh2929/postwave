-- 0292_tag_history.sql
--
-- Tags refinement 3/12 — append-only audit log for every tag mutation.
--
-- Backs three downstream surfaces:
--   * segment predicate "has tag X added after <ts>" (P0 catalogue gap),
--   * the per-tag version history slideover,
--   * webhook fan-out (tag.added / tag.removed events).
--
-- One row per mutation event. action mirrors the legacy
-- 0028_mailchimp_compatibility tag_added / tag_removed enum values
-- so the existing activity_log readers continue to work after the
-- emitter starts dual-writing here.
--
-- For GDPR erasure the writer inserts a redaction row that nulls
-- actor_id but keeps tag_id / occurred_at so the audit chain
-- survives without leaking PII actor identity.

BEGIN;

CREATE TABLE IF NOT EXISTS tag_history (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tag_id        uuid,
    tag_name      text,
    subscriber_id uuid,
    -- Includes the batched bulk events (bulk_applied / bulk_unapplied) so a
    -- fresh in-order replay lands the final widened CHECK directly; 0276
    -- guards its equivalent widen on the table already existing.
    action        text NOT NULL CHECK (action IN (
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
    )),
    source        text NOT NULL DEFAULT 'manual'
        CHECK (length(source) BETWEEN 1 AND 64),
    actor_id      uuid,
    reason        text,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at   timestamptz NOT NULL DEFAULT now()
);

-- BRIN on (tenant_id, occurred_at) for time-range scans (history
-- export, retention sweeps, webhook backfills) — small, append-only.
CREATE INDEX IF NOT EXISTS tag_history_brin_idx
    ON tag_history USING BRIN (tenant_id, occurred_at);

-- B-tree on (tenant_id, tag_id, occurred_at DESC) for per-tag drill-
-- down (the GET /api/v1/tags/{id}/history endpoint).
CREATE INDEX IF NOT EXISTS tag_history_tag_idx
    ON tag_history (tenant_id, tag_id, occurred_at DESC);

-- B-tree on (tenant_id, subscriber_id, occurred_at DESC) so the
-- per-subscriber timeline can pull tag events without a sequential
-- scan over the partition.
CREATE INDEX IF NOT EXISTS tag_history_subscriber_idx
    ON tag_history (tenant_id, subscriber_id, occurred_at DESC);

GRANT SELECT, INSERT ON tag_history TO postwave_app;

ALTER TABLE tag_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_history FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tag_history;
CREATE POLICY tenant_isolation ON tag_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON tag_history;
CREATE POLICY tenant_visible ON tag_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
