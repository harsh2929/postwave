-- 1834_campaign_template_design_actor_recovery.sql
--
-- Supports bounded recovery of acknowledged campaign-template design jobs
-- after a browser or MCP client loses local state. Recovery remains private to
-- the exact tenant + actor that created the draft; archived rows are excluded.

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_template_design_actor_recovery_idx
    ON campaign_template_design_drafts (
        tenant_id,
        actor_type,
        actor_id,
        updated_at DESC,
        id DESC
    )
    WHERE status <> 'archived';
