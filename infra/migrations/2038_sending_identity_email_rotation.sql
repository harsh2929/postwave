-- 2038_sending_identity_email_rotation.sql
--
-- Canonical subscriber-email rotation is transactional across the subscriber
-- row and every email-keyed operational satellite. subscriber_send_log was
-- deliberately created without UPDATE privilege because ordinary frequency
-- recording is append-only; the canonical rotation helper now needs the
-- narrow column grant below to preserve the recipient's active frequency
-- history under the new address. FORCE RLS still requires the same tenant GUC,
-- and no other send-log column becomes mutable.
--
-- intelligent_retry_events already grants UPDATE and is protected by the same
-- tenant RLS, so its collision-aware repoint needs no schema change.
--
-- migration-execution: transactional
-- rollback-strategy: restore
-- rollback-details: Keep the column-scoped grant during application rollback.
-- Older binaries do not issue this UPDATE, while revoking it before every new
-- binary is drained can abort an in-flight subscriber rotation transaction.

BEGIN;

GRANT UPDATE (subscriber_email) ON subscriber_send_log TO postwave_app;

COMMENT ON COLUMN subscriber_send_log.subscriber_email IS
    'Plaintext operational identity; canonical email rotation re-points it transactionally, subject erasure deletes it, and bounded retention purges it after the frequency-cap lookback.';

COMMIT;
