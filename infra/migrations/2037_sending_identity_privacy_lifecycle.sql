-- 2037_sending_identity_privacy_lifecycle.sql
--
-- subscriber_send_log and intelligent_retry_events both retain a recipient's
-- plaintext address. They are operational send-control state, not immutable
-- legal evidence, and the consolidated retention worker now removes them
-- after the tenant's bounded email_event_retention_days window. That setting
-- cannot be below 30 days, which preserves subscriber_send_log for the full
-- 720-hour maximum frequency-cap lookback.
--
-- The worker discovers tenants cross-tenant, then always re-enters a tenant
-- transaction for deletion. FORCE RLS therefore needs a narrowly permissive,
-- SELECT-only discovery path. The separate restrictive policies still deny
-- worker INSERT/UPDATE/DELETE; ordinary tenant writes retain their existing
-- privileges, including DSAR deletion inside a tenant-scoped transaction.
--
-- Build the time-first indexes online: these ledgers can be hot and large, and
-- the existing indexes begin with subscriber_email/status rather than the
-- retention cutoff.
--
-- migration-execution: phased
-- rollback-strategy: restore
-- rollback-details: Keep the indexes and SELECT-only retention discovery
-- policies during application rollback. They do not change existing tenant
-- writes, and removing them would restore indefinite plaintext retention.

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_send_log_retention_idx
    ON subscriber_send_log (tenant_id, sent_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS intelligent_retry_events_retention_idx
    ON intelligent_retry_events (tenant_id, created_at, id)
    INCLUDE (status, updated_at);

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER POLICY tenant_isolation ON subscriber_send_log
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
            AND COALESCE(current_setting('app.retention_worker', true), '') = 'true'
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS subscriber_send_log_retention_worker_select
    ON subscriber_send_log;
CREATE POLICY subscriber_send_log_retention_worker_select
    ON subscriber_send_log
    AS PERMISSIVE
    FOR SELECT TO postwave_app
    USING (
        COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
        AND COALESCE(current_setting('app.retention_worker', true), '') = 'true'
    );

DROP POLICY IF EXISTS intelligent_retry_events_retention_worker_select
    ON intelligent_retry_events;
CREATE POLICY intelligent_retry_events_retention_worker_select
    ON intelligent_retry_events
    AS PERMISSIVE
    FOR SELECT TO postwave_app
    USING (
        COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
        AND COALESCE(current_setting('app.retention_worker', true), '') = 'true'
    );

COMMENT ON COLUMN subscriber_send_log.subscriber_email IS
    'Plaintext operational identity; subject erasure deletes it transactionally and retention purges it after bounded email-event retention (minimum 30 days).';
COMMENT ON COLUMN intelligent_retry_events.subscriber_email IS
    'Plaintext operational identity; subject erasure deletes it transactionally and retention purges it after bounded email-event retention, preserving only a live retry lease.';

COMMIT;
