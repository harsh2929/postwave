-- 0174_api_key_calls.sql
--
-- Per-call observability for API-key-authenticated traffic. Closes
-- the gap "operators can't see what their automations (MCP server,
-- CI scripts, agents) are actually doing" — api_keys.last_used_at
-- gives a single timestamp per key; this table gives a row per call.
--
-- Use cases:
--
--   * The dashboard's new MCP page filters this table on
--     user_agent ILIKE 'postwave-mcp-server/%' to show every tool
--     the agent invoked.
--   * "Why is this API key burning rate limits?" investigations
--     become a single ORDER BY + LIMIT against this table.
--   * Per-key billing reports group by tool name / endpoint.
--
-- Retention: rows older than POSTWAVE_API_KEY_CALLS_RETENTION_DAYS
-- (default 90) are trimmed by the audit-log GC sweeper. The schema
-- doesn't model a tombstone — full delete is fine because there's
-- no FK referencing these rows.
--
-- Volume sizing: an active agent doing ~100 calls/day across 10
-- tenants = ~30k rows/month. Indexes are partial-by-tenant_id so
-- the per-tenant query path stays cheap even at 10M rows total.

BEGIN;

CREATE TABLE IF NOT EXISTS api_key_calls (
    id            bigserial   PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    api_key_id    uuid        REFERENCES api_keys(id) ON DELETE SET NULL,
    -- Frozen prefix copy: api_keys.id can be NULL'd by ON DELETE SET NULL
    -- when an operator revokes the key, but we still want the dashboard
    -- to render "pw_ab12…" rather than "(deleted key)". 8 chars matches
    -- the dashboard's existing prefix display.
    api_key_prefix text       NOT NULL DEFAULT '',
    method        text        NOT NULL,
    path          text        NOT NULL,
    -- Optional logical tool name. The MCP server SHOULD set
    -- X-Postwave-MCP-Tool to the tool name; if absent we derive a
    -- coarse name from method + path's first segment.
    tool_name     text        NOT NULL DEFAULT '',
    status_code   int         NOT NULL,
    latency_ms    int         NOT NULL,
    user_agent    text        NOT NULL DEFAULT '',
    -- The IP the request came from. Tenant-scoped audit / rate-limit
    -- forensics. NULL when the recorder ran without a request (rare).
    remote_ip     text        NOT NULL DEFAULT '',
    error_code    text        NOT NULL DEFAULT '',
    called_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_calls_tenant_called_idx
    ON api_key_calls (tenant_id, called_at DESC);

CREATE INDEX IF NOT EXISTS api_key_calls_tenant_tool_idx
    ON api_key_calls (tenant_id, tool_name, called_at DESC)
    WHERE tool_name <> '';

CREATE INDEX IF NOT EXISTS api_key_calls_tenant_keyid_idx
    ON api_key_calls (tenant_id, api_key_id, called_at DESC)
    WHERE api_key_id IS NOT NULL;

-- Lookup by UA prefix — used by the MCP page's default filter
-- (user_agent ILIKE 'postwave-mcp-server/%'). A partial expression
-- index keeps the predicate cheap without bloating storage for the
-- common-case "any UA" query.
CREATE INDEX IF NOT EXISTS api_key_calls_tenant_mcp_idx
    ON api_key_calls (tenant_id, called_at DESC)
    WHERE user_agent ILIKE 'postwave-mcp-server/%';

ALTER TABLE api_key_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_key_calls_tenant_isolation ON api_key_calls
    FOR ALL
    USING (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON api_key_calls TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE api_key_calls_id_seq TO postwave_app;

COMMIT;
