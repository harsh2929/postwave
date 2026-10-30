-- The API-call retention sweeper uses the bounded shared worker scope. The
-- table was originally granted only SELECT/INSERT and had no worker DELETE
-- policy, so every production sweep failed closed with permission denied.

BEGIN;

GRANT DELETE ON api_key_calls TO postwave_app;

DROP POLICY IF EXISTS api_key_calls_worker_retention_delete ON api_key_calls;
CREATE POLICY api_key_calls_worker_retention_delete ON api_key_calls
    AS PERMISSIVE
    FOR DELETE
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
