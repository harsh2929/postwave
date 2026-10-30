-- 0320_campaign_ai_summaries.sql
--
-- G17 (campaigns 2026): persistent AI post-send summaries.
--
-- After a campaign reaches status=sent the desktop renders an "AI
-- summary" card on CampaignDetailSlideover that pulls open / click
-- rates vs the rolling baseline, the top-link concentration, reply
-- intent buckets (G3), and voice drift score (G10), then hands the
-- raw stats to the voice service for a natural-language synthesis
-- with suggested follow-up actions.
--
-- We persist the rendered summary so reopening the slideover is cheap
-- (one row lookup vs an LLM round-trip) and so the operator's audit
-- trail captures exactly what the assistant said at send time. The
-- backend regenerate endpoint replaces the row in-place — the
-- versioned audit row lives in audit_log keyed by campaign_id.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_ai_summaries (
    campaign_id      uuid        PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Markdown-formatted body. Renderer is responsible for sanitization;
    -- we store as-is so a regenerate roundtrip can compare diffs.
    body_markdown    text        NOT NULL DEFAULT '',
    -- Provenance: "voice" (LLM-synthesized) or "deterministic" (template
    -- renderer when voice is unavailable so the card always has
    -- something to show).
    source           text        NOT NULL DEFAULT 'deterministic',
    -- The stats snapshot the renderer used. Keep as jsonb so future
    -- summary versions can diff against the input data.
    inputs_snapshot  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    generated_at     timestamptz NOT NULL DEFAULT now(),
    -- generated_by_user_id is null when the renderer fired
    -- automatically (the cron / "first open of slideover" path).
    generated_by_user_id uuid    REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS campaign_ai_summaries_tenant_idx
    ON campaign_ai_summaries (tenant_id, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_ai_summaries TO postwave_app;

ALTER TABLE campaign_ai_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_ai_summaries FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_ai_summaries
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_ai_summaries
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
