-- 1200_segment_event_queue.sql
--
-- SUB-029 — live segment recompute on every event.
--
-- Problem: segment membership previously only refreshed on a 5-minute
-- batch cadence (send_time_opt.SegmentMaterializer) or via the manual
-- POST /segments/{id}/recompute endpoint. A subscriber who just opened /
-- clicked / fired a custom event would not flip into (or out of) an
-- event-driven segment until the next batch tick — too slow for
-- send-time-opt and "trigger when subscriber enters segment X" flows.
--
-- Fix: an event-driven recompute queue. When a subscriber event is
-- recorded (subscribers.RecordSubscriberEvent), the ingest path enqueues
-- one (tenant_id, segment_id, subscriber_id, event_type, occurred_at)
-- tuple per affected segment. A fast-path worker
-- (segments.SegmentEventWorker) polls this queue every ~1s, dedups
-- pending rows by segment, recompiles each segment's query_ast → SQL via
-- segments.CompileAST, and rewrites the segment_subscribers cache — so
-- membership flips within seconds of event arrival rather than at the
-- next 5-minute batch.
--
-- Schema notes:
--   * id bigserial PK so the worker can claim + delete a stable batch.
--   * segment_id is nullable: an enqueue with NULL segment_id means
--     "recompute every segment for this tenant" (used when the ingest
--     path opts not to enumerate segments). The worker expands NULL rows
--     to the tenant's segment set.
--   * enqueued_at drives FIFO drain order + a retention sweep.
--   * No unique constraint — the worker dedups by segment at claim time,
--     and a UNIQUE would force an expensive ON CONFLICT on the hot
--     ingest path. The queue is intentionally append-cheap.
--   * RLS via the canonical NULLIF idiom so a missing app.tenant_id GUC
--     fails closed instead of crashing on the empty-string-to-uuid cast
--     (see project_rls_guc_idiom memo). The worker claims rows under a
--     per-tenant scope, so RLS applies on both the ingest INSERT and the
--     worker SELECT/DELETE.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_event_queue (
    id            bigserial   PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    segment_id    uuid            NULL REFERENCES segments(id) ON DELETE CASCADE,
    subscriber_id uuid            NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    event_type    text        NOT NULL DEFAULT '',
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    enqueued_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE segment_event_queue IS
    'SUB-029 pending event-driven segment recompute queue. The fast-path worker (segments.SegmentEventWorker) drains this, dedups by segment, and rewrites segment_subscribers. A NULL segment_id means "recompute all of the tenant''s segments".';

-- FIFO drain order for the worker's claim query.
CREATE INDEX IF NOT EXISTS segment_event_queue_drain_idx
    ON segment_event_queue (tenant_id, enqueued_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_event_queue TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE segment_event_queue_id_seq TO postwave_app;

ALTER TABLE segment_event_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_event_queue FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON segment_event_queue;
CREATE POLICY tenant_isolation ON segment_event_queue
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON segment_event_queue;
CREATE POLICY tenant_visible ON segment_event_queue
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The fast-path drainer (segments.SegmentEventWorker) enumerates which
-- tenants exist via the `tenants` worker_select policy (migration 1708,
-- gated on app.outbox_worker), then binds app.tenant_id per tenant and
-- drains this queue under the per-tenant policies above — so no
-- cross-tenant policy is required on this table itself.

COMMIT;
