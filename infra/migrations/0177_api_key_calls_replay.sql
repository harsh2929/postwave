-- 0177_api_key_calls_replay.sql
--
-- Adds the per-call replay payload + dry-run marker columns to
-- api_key_calls. Pairs with the new MCP guide affordances:
--
--   * Replay  — the dashboard's slide-over offers "Copy as cURL" /
--               "Re-run via MCP". Both need the query string + body
--               summary the call carried; capturing them here lets
--               the dashboard render an authentic command without
--               another endpoint trip.
--
--   * Dry-run — when the MCP server sets X-Postwave-Dry-Run: 1, we
--               record dry_run=true on the row. Mutating endpoints
--               that honour the header skip side effects; the
--               dashboard shows a "dry-run" badge so operators can
--               see at a glance which executions were simulations.
--
-- Why JSONB + size cap: bodies are bounded by the API's
-- httpbody.MaxBodyBytes (64-256 KiB depending on route). We don't
-- want to mirror the full payload into observability — capture a
-- truncated summary (top-level keys + small leaf values), redact
-- known-secret keys, cap at 4 KiB per row. The recorder enforces
-- the cap before insert.

BEGIN;

ALTER TABLE api_key_calls
    ADD COLUMN IF NOT EXISTS query_string  text   NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS request_body  jsonb,
    ADD COLUMN IF NOT EXISTS dry_run       boolean NOT NULL DEFAULT false;

-- Partial index: dashboard's "show me what was simulated" view filters
-- on dry_run=true. Total dry-run rows are << total rows, so the
-- partial index stays small.
CREATE INDEX IF NOT EXISTS api_key_calls_tenant_dryrun_idx
    ON api_key_calls (tenant_id, called_at DESC)
    WHERE dry_run = true;

COMMIT;
