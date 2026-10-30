-- 0163_inbound_webhook_secret_envelope.sql
--
-- Forward-fix for C1 (PRODUCTION_READINESS.md): inbound webhook
-- secrets were stored plaintext in inbound_webhook_endpoints.secret
-- — every other webhook secret in the codebase (outbound_webhooks)
-- is envelope-encrypted via the KMS-envelope or static-KEK cipher.
-- A DB leak = full-keyspace compromise of every customer's inbound
-- webhook signature secret.
--
-- This migration adds a NULLABLE secret_envelope bytea column for
-- the encrypted form. The code path:
--   * Create/RotateSecret writes to secret_envelope (new path)
--   * Verify reads secret_envelope first, falls back to legacy
--     secret column for rows created before the rollout
--   * Migration 1791 classifies historical rows and the bounded
--     SecretMaintenanceWorker envelope-wraps them under worker RLS
--
-- The legacy `secret` column stays for the duration of the
-- maintenance window; it contains only a non-secret sentinel after
-- the worker converges.

BEGIN;

ALTER TABLE inbound_webhook_endpoints
    ADD COLUMN IF NOT EXISTS secret_envelope bytea;

-- secret stays NOT NULL for now (back-compat with the legacy verify
-- path); the backfill job is responsible for ensuring every row has
-- secret_envelope populated before the drop-secret follow-up runs.

COMMIT;
