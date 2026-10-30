-- 0035_outbox.sql
--
-- Transactional outbox.
--
-- Pattern: callers append a row inside the same tx that mutates business
-- state. A worker (apps/api/internal/outbox) claims rows via
-- FOR UPDATE SKIP LOCKED and runs the registered handler for the row's
-- `kind`. On success the row is marked completed; on failure it's bounced
-- back into the queue with backoff until max_attempts is reached.
--
-- This fixes the audit's "Form double-opt-in confirm never enables Listmonk
-- subscriber" finding (and others like it) by giving us a durable mechanism
-- to do "after we commit, also do X" without losing X on a crash.
--
-- Tenant scope: tenant_id is required for every row so RLS still applies.
-- The worker reads under a per-row tenant_id GUC, same as the migration-
-- jobs lease pattern in 0034.

BEGIN;

CREATE TABLE outbox_events (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind            text        NOT NULL,                   -- e.g. 'forms.confirm.enable_listmonk'
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    available_at    timestamptz NOT NULL DEFAULT now(),     -- when worker may claim
    claimed_by      uuid,                                   -- worker process id
    claimed_until   timestamptz,                            -- lease expiry (NULL == unclaimed)
    attempts        int         NOT NULL DEFAULT 0,
    max_attempts    int         NOT NULL DEFAULT 10,
    last_error      text,
    completed_at    timestamptz,                            -- terminal success
    failed_at       timestamptz,                            -- terminal failure (DLQ)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial index supporting the worker claim query.
--
-- We can use IMMUTABLE predicates (`completed_at IS NULL` and
-- `failed_at IS NULL`) but NOT `claimed_until < now()` — Postgres rejects
-- now() in index predicates because it's STABLE, not IMMUTABLE. The
-- "claimed_until is past" comparison happens at query time on the
-- already-narrowed index scan.
CREATE INDEX outbox_events_claimable_idx
    ON outbox_events (available_at)
    WHERE completed_at IS NULL
      AND failed_at IS NULL;

CREATE INDEX outbox_events_tenant_kind_idx
    ON outbox_events (tenant_id, kind, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO postwave_app;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy for the cross-tenant worker claim path. The worker
-- discovers a candidate row platform-wide, then re-scopes app.tenant_id
-- to the candidate's tenant before any subsequent UPDATE. The worker is
-- the only caller that runs without a pre-set tenant context.
CREATE POLICY outbox_worker_select ON outbox_events
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY outbox_worker_update ON outbox_events
    AS PERMISSIVE
    FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
