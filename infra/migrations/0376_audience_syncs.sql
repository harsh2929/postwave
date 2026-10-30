-- 0376_audience_syncs.sql
--
-- GAPS-REMAINING-2026-06-10 item A13: real Audience Syncs (desktop page
-- was a "Coming soon" stub). This is the in-repo, credential-free
-- destination catalog: each row says "push this list's / segment's
-- members to this webhook URL, signed with this secret, on this
-- schedule".
--
-- Scope note (orchestrator decision 2026-06-10): external ad-platform
-- destinations (Meta / Google / Snowflake) need OAuth credentials and
-- stay on the audience_destinations table (migration 0256) until their
-- adapters ship. This table is the *working* surface: destination_type
-- is webhook-only today; the CHECK constraint is widened when a new
-- in-repo destination type lands.
--
-- destination_secret stores the HMAC signing secret. It is tenant-RLS
-- protected, never returned by the read API (handlers mask it), and is
-- used to compute the X-Postwave-Signature header on every delivery
-- (same `t=<unix>,v1=<hex_hmac_sha256>` convention as outbound
-- webhooks — see apps/api/internal/outbound_webhooks/outbound_webhooks.go).
--
-- Exactly one of list_id / segment_id must be set (XOR CHECK).
--
-- last_run_* are denormalised from audience_sync_runs (0377) by the
-- runner so the list view renders without a per-row aggregate.

BEGIN;

CREATE TABLE IF NOT EXISTS audience_syncs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    list_id            uuid,
    segment_id         uuid REFERENCES segments(id) ON DELETE CASCADE,
    destination_type   text NOT NULL DEFAULT 'webhook'
                       CHECK (destination_type IN ('webhook')),
    destination_url    text NOT NULL CHECK (length(destination_url) BETWEEN 1 AND 2048),
    destination_secret text NOT NULL,
    schedule           text NOT NULL DEFAULT 'manual'
                       CHECK (schedule IN ('manual','hourly','daily')),
    enabled            boolean NOT NULL DEFAULT true,
    last_run_at        timestamptz,
    last_run_status    text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Exactly one source.
    CHECK ((list_id IS NULL) <> (segment_id IS NULL)),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS audience_syncs_tenant_idx
    ON audience_syncs (tenant_id, created_at DESC);

-- Scheduler tick: "which enabled, scheduled syncs are due?". Partial so
-- manual-only tenants cost nothing.
CREATE INDEX IF NOT EXISTS audience_syncs_due_idx
    ON audience_syncs (schedule, last_run_at)
    WHERE enabled AND schedule <> 'manual';

CREATE TRIGGER audience_syncs_set_updated_at
    BEFORE UPDATE ON audience_syncs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON audience_syncs TO postwave_app;

ALTER TABLE audience_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_syncs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audience_syncs
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Scheduler enumeration (cross-tenant SELECT under db.WithWorkerScope,
-- mirroring the 0042 abtests pattern). The worker re-binds
-- app.tenant_id per row before running the sync, so all writes go
-- through tenant_isolation.
CREATE POLICY audience_syncs_worker_select ON audience_syncs
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
