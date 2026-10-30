-- 1700_ops_console.sql
-- Platform-operator ops console.
-- Spec: docs/superpowers/specs/2026-07-11-ops-console-design.md
--
-- These are PLATFORM tables, not tenant tables. They hold fleet-wide operator
-- state, have no tenant_id, and are deliberately NOT RLS-protected. They are
-- listed in PLATFORM_TABLE_ALLOWLIST in scripts/lint-migrations.sh.
--
-- The postwave_ops role gets NO access to any base table. Probes read the
-- fleet exclusively through SECURITY DEFINER functions that return scalars
-- and aggregates. The return type is the security boundary: a function that
-- returns (bigint, timestamptz) cannot leak a subscriber row no matter what
-- its body does.
--
-- rollback-strategy: no-op - additive tables, one role and one function; drop
-- them and redeploy the previous image.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS platform_operators (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL UNIQUE,
    totp_secret_enc bytea NOT NULL,
    ip_allowlist    text[] NOT NULL DEFAULT '{}',
    disabled_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- status may only ever be a status the reconciler OBSERVED. 'stale' and 'due'
-- are read-time derivations (ops.Result.Effective) and must never be
-- persisted: if they could be stored, a dead reconciler would freeze the board
-- at its last written value, which is the exact bug this console exists to
-- make impossible.
CREATE TABLE IF NOT EXISTS ops_check_results (
    check_id         text PRIMARY KEY,
    status           text NOT NULL CHECK (status IN ('ok', 'warn', 'red')),
    detail           text NOT NULL DEFAULT '',
    last_reported_at timestamptz NOT NULL,
    last_ok_at       timestamptz,
    first_red_at     timestamptz,
    acked_until      timestamptz,
    ack_reason       text,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_check_history (
    id          bigserial PRIMARY KEY,
    check_id    text NOT NULL,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    detail      text NOT NULL DEFAULT '',
    at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_check_history_check_at_idx
    ON ops_check_history (check_id, at DESC);

CREATE TABLE IF NOT EXISTS ops_manual_log (
    id          bigserial PRIMARY KEY,
    check_id    text NOT NULL,
    operator_id uuid NOT NULL REFERENCES platform_operators (id),
    note        text NOT NULL DEFAULT '',
    ticked_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_manual_log_check_ticked_idx
    ON ops_manual_log (check_id, ticked_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_ops') THEN
        CREATE ROLE postwave_ops NOLOGIN;
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON ops_check_results TO postwave_ops;
GRANT SELECT, INSERT         ON ops_check_history TO postwave_ops;
GRANT SELECT, INSERT         ON ops_manual_log    TO postwave_ops;
GRANT SELECT                 ON platform_operators TO postwave_ops;
GRANT USAGE, SELECT ON SEQUENCE ops_check_history_id_seq TO postwave_ops;
GRANT USAGE, SELECT ON SEQUENCE ops_manual_log_id_seq    TO postwave_ops;

-- The one fleet-read the skeleton needs. Aggregate only: a count and a
-- timestamp. stripe_webhook_attempts is a PLATFORM table (migration 0089):
-- no tenant_id, no RLS. What keeps postwave_ops out is plain privilege:
-- the role has no SELECT grant on the table, and this migration deliberately
-- does not add one. SECURITY DEFINER runs the body with the definer's
-- privileges so the function can read the table anyway; the aggregate-only
-- return type stops it leaking anything but a count and a timestamp.
CREATE OR REPLACE FUNCTION ops_billing_dlq_depth()
RETURNS TABLE (dead_count bigint, oldest_dead_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT count(*)::bigint, min(updated_at)
      FROM stripe_webhook_attempts
     WHERE status = 'dead_lettered';
$$;

REVOKE ALL     ON FUNCTION ops_billing_dlq_depth() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ops_billing_dlq_depth() TO postwave_ops;

COMMIT;
