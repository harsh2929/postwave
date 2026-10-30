-- Give tenant-bound child tables a structural (tenant_id, subscriber_id)
-- reference target. subscribers.id is globally unique already; this redundant
-- composite key prevents a tenant-scoped sidecar row from ever pointing at a
-- subscriber owned by another tenant.
--
-- PostgreSQL cannot build a concurrent index inside a transaction.
-- rollback-strategy: no-op - the redundant unique index is safe to retain during rollback.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscribers_tenant_id_id_uniq
    ON subscribers (tenant_id, id);
