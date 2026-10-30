-- 1785_outbound_webhook_legacy_response_redaction.sql
--
-- Receiver response bodies and transport messages collected before the
-- write-side credential sanitizer could contain echoed bearer tokens, custom
-- authentication headers, or URL credentials. Historical text cannot be
-- reliably redacted without the original request context, so replace it with
-- a non-sensitive provenance marker. New rows are sanitized before storage.

BEGIN;

-- outbound_webhook_deliveries is FORCE RLS. The existing, narrowly scoped
-- worker policies are the only cross-tenant path; without this transaction-
-- local flag the migration would silently update zero rows.
SELECT set_config('app.outbox_worker', 'true', true);

UPDATE outbound_webhook_deliveries
   SET last_response_body_truncated = CASE
           WHEN COALESCE(last_response_body_truncated, '') = '' THEN last_response_body_truncated
           ELSE '[legacy receiver response hidden after security hardening]'
       END,
       last_error = CASE
           WHEN COALESCE(last_error, '') = '' THEN last_error
           ELSE '[legacy delivery error hidden after security hardening]'
       END
 WHERE COALESCE(last_response_body_truncated, '') <> ''
    OR COALESCE(last_error, '') <> '';

COMMIT;
