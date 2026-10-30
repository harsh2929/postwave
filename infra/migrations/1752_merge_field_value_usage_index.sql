-- Support schema usage counts, the compatibility sidecar lookup, and parent
-- key cascades without repeatedly scanning every subscriber value in a tenant.
-- This file intentionally has no BEGIN/COMMIT because PostgreSQL forbids
-- concurrent index builds inside a transaction.
-- rollback-strategy: no-op - the index is additive and safe to retain when
-- rolling application code back.

CREATE INDEX CONCURRENTLY IF NOT EXISTS merge_field_values_tenant_key_usage_idx
    ON merge_field_values (tenant_id, key);
