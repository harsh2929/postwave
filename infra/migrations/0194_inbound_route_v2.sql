-- 0194_inbound_route_v2.sql
--
-- Inbound Routes v2 hardening — closes the observability + reliability
-- gaps identified in the comprehensive audit:
--
--   1. `inbound_route_action_runs` — per-action outcome log. Each
--      time a route's action pipeline executes, we write one row per
--      action with its kind, status (succeeded/failed/skipped), HTTP
--      response code (when applicable), a truncated response body
--      snippet (for webhook actions), the per-action duration, and
--      a final-attempt flag. The audit's #1 PM complaint — "did my
--      webhook actually fire?" — is unanswerable without this.
--
--      Indexed for two reads:
--        - The match-detail UI (list runs for one match)
--        - The route-detail UI (recent runs across all matches for a
--          single route, drives the failure-rate display)
--
--      Retention: 30 days, matches the existing inbound_route_matches
--      pruner so failure data + match data have the same horizon.
--
--   2. Retry policy columns on `inbound_routes`:
--        - `action_retry_max` (0-5) — number of additional attempts
--          after the first failure. Default 0 preserves v1 behaviour.
--        - `action_retry_backoff_seconds` — base delay between
--          retries; the executor applies exponential backoff so
--          actual delays are base, 2*base, 4*base, …
--
--      These only affect retryable actions (webhook, automation_trigger,
--      forward). The `tag` and `store_only` actions are local writes
--      with no retryable failure mode.
--
--   3. Bookkeeping fields the v1 migration (0125) provisioned but
--      never wired:
--        - `inbound_emails.matched_route_id` — first matched route id
--          (NULL on no-match). The 0125 partial index waits for this.
--        - `inbound_emails.route_actions_applied` — JSONB summary of
--          which kinds fired, for ops queries like "how many emails
--          got tagged automatically last week".
--
--      We do NOT backfill — there's no historical action-run data to
--      reconstruct. Forward-only.
--
--   4. CHECK on `inbound_routes.actions` — JSONB must be a non-null
--      array. The frontend silent-keep bug + the backend
--      `CASE WHEN '[]' THEN actions ELSE…` guard cooperatively
--      prevented intentional action clearing; v2 fixes that in code,
--      but the CHECK guards against a NULL slip-through. Empty array
--      is allowed (a route can legitimately be store_only-by-default
--      via zero actions).

BEGIN;

-- 1. Per-action run log.
CREATE TABLE inbound_route_action_runs (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           UUID        NOT NULL REFERENCES tenants(id)        ON DELETE CASCADE,
    route_id            UUID        NOT NULL REFERENCES inbound_routes(id) ON DELETE CASCADE,
    -- Soft FK — match rows can be retention-pruned independently.
    match_id            BIGINT,
    action_index        INT         NOT NULL,
    action_kind         TEXT        NOT NULL,
    status              TEXT        NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
    -- Number of attempts taken (1 = succeeded first try, 4 = three
    -- retries + final success/failure).
    attempts            INT         NOT NULL DEFAULT 1,
    -- HTTP response code for webhook + automation_trigger actions
    -- (the actions that POST to upstreams). NULL for tag / forward /
    -- store_only — those don't have a meaningful single-int status.
    http_status         INT,
    -- First 512 bytes of the response body, captured for webhook
    -- actions so operators can see "what did my server reply".
    -- Truncated server-side to keep the log table small.
    response_snippet    TEXT,
    -- Final attempt's error message (when status='failed'). NULL on
    -- success so the column is small for the common case.
    error_message       TEXT,
    -- Total wall-clock time for the action including any retries.
    duration_ms         INT         NOT NULL DEFAULT 0,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-match drilldown: "show me what each action did for this match".
CREATE INDEX inbound_route_action_runs_match_idx
    ON inbound_route_action_runs (match_id, action_index)
    WHERE match_id IS NOT NULL;

-- Per-route failure-rate over recent time window: drives the route
-- list's "last error" / "failure rate" cells.
CREATE INDEX inbound_route_action_runs_route_recent_idx
    ON inbound_route_action_runs (route_id, executed_at DESC);

-- Retention pruner — same shape as inbound_route_matches.
CREATE INDEX inbound_route_action_runs_retention_idx
    ON inbound_route_action_runs (executed_at);

GRANT SELECT, INSERT, DELETE ON inbound_route_action_runs TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE inbound_route_action_runs_id_seq TO postwave_app;

ALTER TABLE inbound_route_action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_route_action_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_route_action_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON inbound_route_action_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Retention worker bypass — mirrors the inbound_route_matches pattern.
CREATE POLICY worker_retention ON inbound_route_action_runs
    AS PERMISSIVE FOR DELETE
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- 2. Retry policy on routes.
ALTER TABLE inbound_routes
    ADD COLUMN IF NOT EXISTS action_retry_max               INT     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS action_retry_backoff_seconds   INT     NOT NULL DEFAULT 2;

ALTER TABLE inbound_routes
    ADD CONSTRAINT inbound_routes_retry_max_chk
    CHECK (action_retry_max BETWEEN 0 AND 5),
    ADD CONSTRAINT inbound_routes_retry_backoff_chk
    CHECK (action_retry_backoff_seconds BETWEEN 0 AND 60);

-- 4. Defensive: the `actions` JSONB must be an array, never NULL or a
-- non-array. The legacy `'[]'::jsonb` default already enforces this on
-- new rows; the constraint catches anything bypassing the helpers.
ALTER TABLE inbound_routes
    ADD CONSTRAINT inbound_routes_actions_is_array_chk
    CHECK (jsonb_typeof(actions) = 'array');

COMMIT;
