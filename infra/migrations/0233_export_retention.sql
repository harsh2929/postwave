-- 0225_export_retention.sql
--
-- Workstream 4 (Mailchimp parity polish) — export retention policy.
--
-- Tenants get to pick how long Postwave keeps their export ZIPs before
-- the cleanup job deletes them (default 30 days; 7 days minimum to allow
-- for download + verify; 2555 days = 7 years for SOC 2 record retention).
-- Also caps the number of concurrent stored bundles per tenant.
--
-- The current_storage_bytes column is denormalized — recomputed by the
-- retention worker on each pass. Cheap to compute (sum of bytes_total
-- over tenant_exports where status='ready' and (expires_at IS NULL
-- OR expires_at > now())) but expensive to compute on every settings
-- read.

BEGIN;

CREATE TABLE export_retention_policy (
    tenant_id            uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    retention_days       int         NOT NULL DEFAULT 30
                         CHECK (retention_days BETWEEN 7 AND 2555),
    max_per_tenant       int         NOT NULL DEFAULT 20
                         CHECK (max_per_tenant BETWEEN 1 AND 500),
    current_storage_bytes bigint     NOT NULL DEFAULT 0
                         CHECK (current_storage_bytes >= 0),
    last_recomputed_at   timestamptz,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMIT;
