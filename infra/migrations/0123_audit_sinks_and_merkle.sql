-- 0123_audit_sinks_and_merkle.sql
--
-- Audit log streaming sinks (S3 / Datadog / Splunk) + Merkle hash-chain
-- tamper evidence. Two parts:
--
-- 1. audit_sinks: tenant-configured external destinations. Each row
--    is one sink with a `kind` (s3, datadog, splunk, http), a target
--    URL/bucket, and an encrypted credential blob (re-uses the
--    platform envelope cipher in apps/api/internal/crypto).
--
-- 2. audit_log Merkle columns:
--
--      prev_hash      sha256(prev_row's row_hash)  — chains the log
--      row_hash       sha256(canonical row bytes || prev_hash) — this row's digest
--      signed_root    sha256 root snapshot signed periodically by a
--                     hash-chain-tip worker (separate audit_merkle_roots
--                     table; readers can verify by walking back from
--                     any signed root to the row they care about).
--
--    Why row-level + periodic roots vs. continuous signing: signing on
--    every row would block the audit-write path on a KMS round trip.
--    A periodic root + per-row chain hash gives strong tamper
--    evidence (any tampered row breaks the chain visible at the next
--    root) without blocking writes.

BEGIN;

-- audit_sinks: one row per (tenant, destination).
CREATE TABLE IF NOT EXISTS audit_sinks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('s3','datadog','splunk','http')),
    name          text NOT NULL DEFAULT '',
    enabled       boolean NOT NULL DEFAULT true,
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Credentials envelope-encrypted at rest. Provider-specific:
    --   s3:       { aws_access_key_id, aws_secret_access_key, region, bucket, prefix }
    --   datadog:  { api_key, site (e.g. "datadoghq.com") }
    --   splunk:   { token, hec_url }
    --   http:     { bearer_token | { username,password } | { hmac_secret } }
    credentials_envelope bytea,
    last_success_at      timestamptz,
    last_failure_at      timestamptz,
    last_failure_reason  text,
    consecutive_failures int NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_audit_sinks_tenant
    ON audit_sinks (tenant_id, enabled);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_sinks TO postwave_app;

ALTER TABLE audit_sinks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_sinks AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The streaming worker iterates every tenant's enabled sinks.
CREATE POLICY audit_sinks_worker_select ON audit_sinks
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY audit_sinks_worker_update ON audit_sinks
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- Merkle chain columns on audit_log.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS prev_hash  bytea,
    ADD COLUMN IF NOT EXISTS row_hash   bytea;

-- Index on row_hash so the verifier can re-hash arbitrary rows
-- against their stored digest cheaply.
CREATE INDEX IF NOT EXISTS idx_audit_log_row_hash_tenant
    ON audit_log (tenant_id, id DESC);

-- audit_merkle_roots: periodic roots signed by the chain-tip worker.
-- Each row = "as of this audit_log.id, the chain root was X". The
-- worker re-roots every N seconds (default 60s) so verification
-- needs to walk at most N seconds of rows backward from any signed
-- root.
CREATE TABLE IF NOT EXISTS audit_merkle_roots (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL,
    upto_audit_id  bigint NOT NULL,        -- last audit_log row covered
    root_hash      bytea NOT NULL,         -- sha256 of the chain tip
    signature      bytea,                  -- optional KMS-signed root
    signature_kid  text,                   -- KMS key id (when signed)
    rooted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_merkle_roots_tenant
    ON audit_merkle_roots (tenant_id, rooted_at DESC);

GRANT SELECT, INSERT ON audit_merkle_roots TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_merkle_roots_id_seq TO postwave_app;

ALTER TABLE audit_merkle_roots ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_merkle_roots AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY audit_merkle_roots_worker_all ON audit_merkle_roots
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- audit_sink_failures: per-row + per-sink delivery failure log. Lets
-- the operator drill down on a sink that's emitting 401s, 5xxs, etc.
-- Bounded by a daily janitor sweep.
CREATE TABLE IF NOT EXISTS audit_sink_failures (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL,
    sink_id         uuid NOT NULL REFERENCES audit_sinks(id) ON DELETE CASCADE,
    audit_log_id    bigint,
    status_code     int,
    error           text NOT NULL,
    failed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_sink_failures_sink
    ON audit_sink_failures (sink_id, failed_at DESC);

GRANT SELECT, INSERT, DELETE ON audit_sink_failures TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_sink_failures_id_seq TO postwave_app;

ALTER TABLE audit_sink_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_sink_failures AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY audit_sink_failures_worker_all ON audit_sink_failures
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
