-- 1701_ops_push_state.sql
-- Push/digest runtime state for the ops console (Plan 2).
-- PLATFORM tables (no tenant dimension, no RLS) — listed in
-- PLATFORM_TABLE_ALLOWLIST in scripts/lint-migrations.sh.
--
-- ops_push_state persists the flap-damping state machine per check, plus a
-- reserved '__push_loop__' row the push worker heartbeats every tick so the
-- push-canary check can detect a dead push loop (a dead alert pipeline must
-- not present as a quiet one).
--
-- ops_digest_state is a singleton claim row: the daily digest is sent by
-- whichever replica wins a single atomic UPDATE, so restarts and multiple
-- replicas cannot double-send.
--
-- rollback-strategy: no-op - additive tables; drop them and redeploy the
-- previous image (push simply stops, the board itself is unaffected).

BEGIN;

CREATE TABLE IF NOT EXISTS ops_push_state (
    check_id                text PRIMARY KEY,
    last_notified_class     text NOT NULL DEFAULT '' CHECK (last_notified_class IN ('', 'ok', 'red')),
    candidate_class         text NOT NULL DEFAULT '' CHECK (candidate_class IN ('', 'ok', 'red')),
    candidate_streak        int  NOT NULL DEFAULT 0,
    last_alert_at           timestamptz,
    last_critical_repush_at timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_digest_state (
    id           boolean PRIMARY KEY DEFAULT true CHECK (id),
    last_sent_on date,
    last_sent_at timestamptz
);

INSERT INTO ops_digest_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON ops_push_state  TO postwave_ops;
GRANT SELECT, UPDATE         ON ops_digest_state TO postwave_ops;

COMMIT;
