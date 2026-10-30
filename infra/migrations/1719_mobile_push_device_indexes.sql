-- 1719_mobile_push_device_indexes.sql
-- post-transaction indexes for 1717; this file intentionally has no BEGIN so
-- PostgreSQL can build them concurrently on an upgraded production database.

CREATE INDEX CONCURRENTLY IF NOT EXISTS mobile_push_devices_user_idx
    ON mobile_push_devices (tenant_id, user_id, status, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS mobile_push_deliveries_status_idx
    ON mobile_push_deliveries (tenant_id, status, next_retry_at)
    WHERE status IN ('queued', 'failed');
