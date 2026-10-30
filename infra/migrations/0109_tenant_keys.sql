-- 0109_tenant_keys.sql
-- BYOK (Bring-Your-Own-Key) tenant-level KEK registry.
--
-- Each row references a tenant-controlled Key-Encryption-Key (KEK) held
-- in the customer's chosen KMS (AWS KMS, GCP KMS, HashiCorp Vault, or a
-- local Tink keyset). The cipher layer (apps/api/internal/byok)
-- resolves the active key per tenant_id and routes wrap/unwrap calls to
-- the matching provider in packages/kms.
--
-- Wire integration: blob version 0x03 in apps/api/internal/crypto stores
-- the tenant_keys.id at the start of the framed ciphertext, so Decrypt
-- knows which provider + key_ref to call without an out-of-band lookup.
--
-- Lifecycle: at most one row per tenant has status='active' (enforced
-- by a partial unique index). Rotation flips the old row to 'inactive'
-- and creates a new 'active' row. Old rows stay around for decryption
-- of existing ciphertext.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_keys (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    provider          text NOT NULL CHECK (provider IN ('aws','gcp','vault','tink')),
    key_ref           text NOT NULL,
    status            text NOT NULL DEFAULT 'inactive'
                          CHECK (status IN ('active','inactive','deleted')),
    description       text NOT NULL DEFAULT '',

    -- audit trail
    created_by_user_id uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    activated_at       timestamptz,
    rotated_at         timestamptz,
    deleted_at         timestamptz,
    last_health_check_at  timestamptz,
    last_health_check_ok  boolean,
    last_health_check_err text
);

-- One active key per tenant. Partial unique index lets multiple inactive
-- rows coexist (rotation history + soft-deleted) while making
-- "tenant has at most one active KEK" a database-level invariant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_keys_active
    ON tenant_keys (tenant_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tenant_keys_tenant
    ON tenant_keys (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_keys TO postwave_app;

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON tenant_keys AS PERMISSIVE FOR ALL TO postwave_app
    USING  (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Background workers (rewrap job, KMS audit cron) sweep every tenant's
-- rows without a tenant context. Same permissive pattern outbound
-- webhooks use.
CREATE POLICY tenant_keys_worker_select ON tenant_keys
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY tenant_keys_worker_update ON tenant_keys
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
