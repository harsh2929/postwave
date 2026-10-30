-- 0264_audit_sink_keys.sql
--
-- Standard Webhooks signing + idempotency support for audit sinks.
-- Adds:
--
--   1. webhook_format column on audit_sinks (postwave_v1 | standard_webhooks)
--      so HTTP-kind sinks can opt in to the RFC 9499 signature shape
--      (Standard Webhooks spec) — i.e. `webhook-id` / `webhook-timestamp`
--      / `webhook-signature: v1,<base64>` headers — required by enterprise
--      SIEM ingest pipelines (Microsoft Sentinel CCF, AWS Security Lake
--      via OCSF, Splunk Cloud, Datadog SIEM). Default remains the legacy
--      `postwave_v1` shape (`X-Postwave-Signature: sha256=<hex>`) so
--      existing sinks keep working without a config change.
--
--   2. audit_sink_signing_keys: one row per (sink, kid). Worker rotates
--      keys on a TTL (default 90 days) — insert a new key, leave the old
--      one with revoked_at=NULL for a grace window, then mark it revoked.
--      JWKS endpoint at /api/v1/audit-sinks/{id}/.well-known/jwks.json
--      publishes all non-revoked keys so receivers can verify signatures
--      across rotation boundaries.
--
--   3. event_id column on audit_log: stable UUIDv5 derived from
--      (tenant_id, action, resource_type, resource_id, actor_label,
--      unix_seconds). Used as the Standard Webhooks `webhook-id` header
--      so receivers can dedupe replays end-to-end — even if the same row
--      ships through multiple retries or via the DLQ replay path.
--
-- RLS pattern: every policy reads tenant_id via the NULLIF GUC idiom
-- (NULLIF(current_setting('app.tenant_id', true), '')::uuid) so an unset
-- GUC degrades to NULL instead of crashing the query (Postwave house
-- style; see infra/migrations/0123_audit_sinks_and_merkle.sql).

BEGIN;

-- Add the format selector to audit_sinks. Defaults to postwave_v1 so all
-- pre-existing rows keep emitting the legacy X-Postwave-Signature shape
-- — opt-in upgrade per sink.
ALTER TABLE audit_sinks
    ADD COLUMN IF NOT EXISTS webhook_format text NOT NULL DEFAULT 'postwave_v1'
        CHECK (webhook_format IN ('postwave_v1', 'standard_webhooks'));

-- audit_sink_signing_keys: per-sink rotateable HMAC keys for Standard
-- Webhooks signing. secret_envelope is envelope-encrypted at rest under
-- the same BYOK composite cipher the credentials_envelope uses.
CREATE TABLE IF NOT EXISTS audit_sink_signing_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    sink_id         uuid NOT NULL REFERENCES audit_sinks(id) ON DELETE CASCADE,
    -- kid is the JWKS key identifier; surfaces in the webhook-signature
    -- header so receivers can pick the right key during rotation. Short
    -- random hex; unique per (tenant, sink).
    kid             text NOT NULL,
    -- alg is fixed to HS256 today; column exists so future RS256/EdDSA
    -- support is an additive migration, not a schema rewrite.
    alg             text NOT NULL DEFAULT 'HS256'
        CHECK (alg IN ('HS256')),
    secret_envelope bytea NOT NULL,
    rotated_at      timestamptz NOT NULL DEFAULT now(),
    -- revoked_at NULL = active; SET = revoked. Worker keeps a recently-
    -- revoked key visible in JWKS for a grace window to absorb in-flight
    -- verifications.
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, sink_id, kid)
);

CREATE INDEX IF NOT EXISTS idx_audit_sink_signing_keys_sink
    ON audit_sink_signing_keys (sink_id, revoked_at, rotated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_sink_signing_keys_tenant_active
    ON audit_sink_signing_keys (tenant_id, revoked_at) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_sink_signing_keys TO postwave_app;

ALTER TABLE audit_sink_signing_keys ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped read+write under the standard GUC idiom.
CREATE POLICY tenant_visible ON audit_sink_signing_keys
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Worker access (same app.outbox_worker GUC the delivery + merkle workers
-- use) so the rotation job can INSERT new keys + UPDATE revoked_at across
-- every tenant without setting per-tenant GUCs.
CREATE POLICY audit_sink_signing_keys_worker_all ON audit_sink_signing_keys
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- Stable idempotency key on audit_log. UUIDv5 derived from
-- (tenant_id, action, resource_type, resource_id, actor_label,
-- unix_seconds) — deterministic across retries so the Standard Webhooks
-- `webhook-id` header is the same regardless of how many times we ship
-- the row. NULLable so older rows (pre-migration) just don't get one;
-- the worker generates on the fly for them.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS event_id uuid;

CREATE INDEX IF NOT EXISTS idx_audit_log_event_id_tenant
    ON audit_log (tenant_id, event_id) WHERE event_id IS NOT NULL;

COMMIT;
