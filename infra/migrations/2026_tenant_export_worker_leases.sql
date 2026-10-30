-- 2026_tenant_export_worker_leases.sql
--
-- Export construction can take long enough that holding a database row lock is
-- not viable. The original worker committed `status = running` before doing
-- the work but had no lease, so a process crash stranded that export forever.
-- These columns let a replacement worker reclaim only an expired attempt and
-- fence every heartbeat and terminal write with an opaque attempt token.

BEGIN;

ALTER TABLE tenant_exports
    ADD COLUMN IF NOT EXISTS lease_token uuid,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bundle_sha256 text;

ALTER TABLE tenant_exports
    DROP CONSTRAINT IF EXISTS tenant_exports_attempt_count_bounds;
ALTER TABLE tenant_exports
    ADD CONSTRAINT tenant_exports_attempt_count_bounds
    CHECK (attempt_count >= 0) NOT VALID;
ALTER TABLE tenant_exports
    VALIDATE CONSTRAINT tenant_exports_attempt_count_bounds;

ALTER TABLE tenant_exports
    DROP CONSTRAINT IF EXISTS tenant_exports_bundle_sha256_shape;
ALTER TABLE tenant_exports
    ADD CONSTRAINT tenant_exports_bundle_sha256_shape
    CHECK (
        bundle_sha256 IS NULL
        OR bundle_sha256 ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
ALTER TABLE tenant_exports
    VALIDATE CONSTRAINT tenant_exports_bundle_sha256_shape;

-- Keep legacy pre-lease keys readable, but require every newly written
-- attempt key to bind to this exact tenant/job and to carry the independently
-- persisted digest checked by the authenticated download route. NOT VALID
-- preserves quarantine of a malformed historical row while rejecting every
-- future INSERT/UPDATE that repeats it.
ALTER TABLE tenant_exports
    DROP CONSTRAINT IF EXISTS tenant_exports_private_object_binding;
ALTER TABLE tenant_exports
    ADD CONSTRAINT tenant_exports_private_object_binding
    CHECK (
        object_key IS NULL
        OR object_key = 'exports/' || tenant_id::text || '/' || id::text || '.zip'
        OR (
            object_key ~ (
                '^exports/' || tenant_id::text || '/' || id::text ||
                '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$'
            )
            AND bundle_sha256 IS NOT NULL
        )
    ) NOT VALID;

COMMENT ON COLUMN tenant_exports.lease_token IS
    'Opaque worker-attempt fencing token. Heartbeats and terminal writes must match it.';
COMMENT ON COLUMN tenant_exports.lease_expires_at IS
    'After this instant another export worker may reclaim the running attempt.';
COMMENT ON COLUMN tenant_exports.heartbeat_at IS
    'Last successful renewal of the current worker attempt.';
COMMENT ON COLUMN tenant_exports.attempt_count IS
    'Number of initial or crash-recovery claims; ordinary handled failures are terminal.';
COMMENT ON COLUMN tenant_exports.bundle_sha256 IS
    'Lowercase SHA-256 of the complete private ZIP, persisted independently from object storage and verified before download.';

COMMIT;

-- tenant_exports can be large in a mature workspace. Build the crash-recovery
-- claim path online after the metadata transaction so deploys do not take a
-- blocking table lock or run CREATE INDEX CONCURRENTLY inside a transaction.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS tenant_exports_expired_lease_idx
    ON tenant_exports (lease_expires_at, created_at, id)
    WHERE status = 'running';

RESET statement_timeout;
RESET lock_timeout;
