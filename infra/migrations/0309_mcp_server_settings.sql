-- 0309_mcp_server_settings.sql
--
-- archive-mcp-server (P2, surface=both)
--
-- Postwave already ships an MCP _client integration_ — an npm package
-- (`@postwave/mcp-server`) that LLM clients run locally and that
-- authenticates with the regular HTTPS REST API via a tenant API key.
-- This migration adds the data model for the _native_ MCP server: an
-- HTTP endpoint at /api/v1/mcp/rpc that speaks the Model Context
-- Protocol (JSON-RPC 2.0) directly, so Claude / ChatGPT / Gemini /
-- Perplexity clients can connect with zero npm tooling.
--
-- Beehiiv (Mar 2026), Customer.io (May 2026), and Mailchimp (Claude
-- + ChatGPT apps) all shipped this surface in 2026. Postwave had no
-- such endpoint until this gap; the desktop MCP guide page told users
-- to install an npm package. Native = strictly fewer install steps
-- and removes the local proxy as a failure surface.
--
-- Per-tenant settings:
--
--   • `enabled`           — master switch. When false the /rpc
--                            endpoint 404s for this tenant even if a
--                            valid API key is presented.
--   • `write_enabled`     — gates the write-tier tools (search /
--                            getStats / getAudienceHeatmap remain
--                            read-only regardless; this flag controls
--                            whether the LLM can mutate via tools
--                            like createSubscriber / sendCampaign in
--                            future revisions). v1 ships read-only
--                            only and stores the flag for the UI
--                            scaffold.
--   • `allowed_tools`     — optional tool-name allowlist. NULL or
--                            empty array = all tools the API key
--                            scope grants. When non-empty, the
--                            intersection of (api-key scope) ∩
--                            (allowed_tools) is what the LLM sees
--                            via tools/list.
--   • `last_handshake_at` — set every time the /rpc initialize
--                            method succeeds. Surfaces "last
--                            connected" in the desktop settings panel.
--   • `last_tool_call_at` — set every time tools/call succeeds, for
--                            the same panel.
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair using the
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_server_settings (
    tenant_id          UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled            BOOLEAN NOT NULL DEFAULT true,
    write_enabled      BOOLEAN NOT NULL DEFAULT false,
    -- Optional tool allowlist. NULL or empty = all tools the API key
    -- scope authorises. Stored as text[] so the operator can pick from
    -- the static catalogue exposed by GET /api/v1/mcp/server/catalog.
    allowed_tools      TEXT[],
    last_handshake_at  TIMESTAMPTZ,
    last_tool_call_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_server_settings TO postwave_app;

ALTER TABLE mcp_server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_server_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mcp_server_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON mcp_server_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-tool call counter, used by the desktop "MCP RPC" panel and by
-- the tools/list method to prune tools that have hit a per-tenant
-- daily cap. The rolling-window cap is computed off this row by the
-- handler — keeping the table dead simple avoids a separate metrics
-- pipeline for what's already a low-volume surface.
CREATE TABLE IF NOT EXISTS mcp_server_call_log (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tool_name  TEXT NOT NULL,
    api_key_id UUID,
    called_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Per-call latency in milliseconds. 0 for failures that abort
    -- before the tool runs.
    latency_ms INTEGER NOT NULL DEFAULT 0,
    -- "ok" | "denied" | "error" | "not_found".
    outcome    TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS mcp_server_call_log_tenant_called_idx
    ON mcp_server_call_log (tenant_id, called_at DESC);

CREATE INDEX IF NOT EXISTS mcp_server_call_log_tool_idx
    ON mcp_server_call_log (tenant_id, tool_name, called_at DESC);

GRANT SELECT, INSERT, DELETE ON mcp_server_call_log TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE mcp_server_call_log_id_seq TO postwave_app;

ALTER TABLE mcp_server_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_server_call_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mcp_server_call_log
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON mcp_server_call_log
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
