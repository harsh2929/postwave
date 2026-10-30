-- 1788_outbound_webhook_source_event_idempotency.sql
--
-- One domain event may be observed more than once during relay recovery or a
-- rolling deployment. A receiver must still see at most one Postwave delivery
-- id for each subscribed webhook and source event.

-- Concurrent indexes remain outside transactions because PostgreSQL cannot
-- build them inside BEGIN/COMMIT. The receipt table/policies below use their
-- own explicit transaction so a partial migration rerun cannot stop on an
-- already-created policy.

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS source_event_id uuid;

-- Build the final shape under a fresh name before removing the pre-release
-- index name. This keeps reruns safe if an earlier local/staging execution
-- created that name with an obsolete column set or predicate: IF NOT EXISTS
-- alone would otherwise accept the wrong definition silently.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhook_deliveries_source_event_uidx_v2
    ON outbound_webhook_deliveries
       (tenant_id, webhook_id, source_event_id)
    WHERE source_event_id IS NOT NULL
      AND parent_delivery_id IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS outbound_webhook_deliveries_source_event_uidx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhook_deliveries_source_trace_idx
    ON outbound_webhook_deliveries (tenant_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

-- One PII-free receipt per authoritative domain event makes identity
-- collisions observable even when the tenant had zero matching destinations
-- at occurrence time. Delivery payloads remain in the delivery table.
BEGIN;

CREATE TABLE IF NOT EXISTS outbound_webhook_event_receipts (
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_event_id uuid        NOT NULL,
    event_type      text        NOT NULL CHECK (
        length(event_type) BETWEEN 1 AND 128
    ),
    occurred_at     timestamptz NOT NULL,
    payload_sha256  bytea       NOT NULL CHECK (octet_length(payload_sha256) = 32),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_event_id)
);

GRANT SELECT, INSERT, DELETE ON outbound_webhook_event_receipts TO postwave_app;

ALTER TABLE outbound_webhook_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_event_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_webhook_event_receipts_tenant
    ON outbound_webhook_event_receipts;

DROP POLICY IF EXISTS outbound_webhook_event_receipts_tenant_select
    ON outbound_webhook_event_receipts;
DROP POLICY IF EXISTS outbound_webhook_event_receipts_tenant_insert
    ON outbound_webhook_event_receipts;
DROP POLICY IF EXISTS outbound_webhook_event_receipts_retention_delete
    ON outbound_webhook_event_receipts;

CREATE POLICY outbound_webhook_event_receipts_tenant_select
    ON outbound_webhook_event_receipts
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY outbound_webhook_event_receipts_tenant_insert
    ON outbound_webhook_event_receipts
    AS PERMISSIVE FOR INSERT
    TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY outbound_webhook_event_receipts_retention_delete
    ON outbound_webhook_event_receipts
    AS PERMISSIVE FOR DELETE
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.retention_worker', true) = 'true'
    );

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhook_event_receipts_time_idx
    ON outbound_webhook_event_receipts (tenant_id, occurred_at DESC, source_event_id);
