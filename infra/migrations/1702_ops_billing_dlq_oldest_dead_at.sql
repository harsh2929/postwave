-- 1702_ops_billing_dlq_oldest_dead_at.sql
-- Follow-up fix to 1700: ops_billing_dlq_depth() computed oldest_dead_at
-- as min(updated_at), not min(dead_lettered_at). Any later touch of a
-- dead row (a replay attempt, a janitor pass) advances updated_at, so the
-- RED alert said "oldest 0s ago" for an event dead-lettered 8 days
-- earlier -- an alert that understates incident age by a week actively
-- misleads triage during a real incident.
--
-- Use dead_lettered_at (set by the 0089 state machine when a row enters
-- status = 'dead_lettered'), with a coalesce to updated_at purely as a
-- belt-and-braces fallback for any legacy row that reached the status
-- without the timestamp.
--
-- CREATE OR REPLACE preserves the function's owner and ACL; the REVOKE /
-- GRANT pair is restated anyway so this file, like 1700, fully describes
-- who may call it.
--
-- rollback-strategy: no-op - aggregate-only read function; re-running the
-- 1700 definition restores the previous (buggy) behavior if ever needed.

BEGIN;

CREATE OR REPLACE FUNCTION ops_billing_dlq_depth()
RETURNS TABLE (dead_count bigint, oldest_dead_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT count(*)::bigint, min(coalesce(dead_lettered_at, updated_at))
      FROM stripe_webhook_attempts
     WHERE status = 'dead_lettered';
$$;

REVOKE ALL     ON FUNCTION ops_billing_dlq_depth() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ops_billing_dlq_depth() TO postwave_ops;

COMMIT;
