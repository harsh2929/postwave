-- 1778_dsar_erasure_update_permissions.sql
--
-- Art. 17 erasure replaces direct identifiers in retained engagement and
-- consent evidence. These tables were originally append-only and therefore
-- granted postwave_app only SELECT/INSERT, which caused the erasure
-- transaction to fail before it could scrub sequence history. Grant only the
-- columns the privacy erasure routine is allowed to anonymize; tenant RLS
-- remains mandatory for every update.

BEGIN;

GRANT UPDATE (subscriber_email, user_agent, ip)
    ON subscriber_events TO postwave_app;

GRANT UPDATE (subscriber_email, ip)
    ON consent_receipts TO postwave_app;

COMMIT;
