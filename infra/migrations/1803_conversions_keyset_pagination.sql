-- 1803_conversions_keyset_pagination.sql
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the additive index during application rollback.
-- Older replicas can use it for their timestamp-only ordering; dropping it
-- while newer replicas are live would regress deterministic keyset reads.
--
-- Conversion feed pages are ordered by (occurred_at DESC, id DESC). The id
-- tie-breaker prevents rows that share a timestamp from being skipped between
-- pages, while tenant_id remains the leading key for RLS-scoped lookups.

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_tenant_at_id_idx
    ON conversions (tenant_id, occurred_at DESC, id DESC);
