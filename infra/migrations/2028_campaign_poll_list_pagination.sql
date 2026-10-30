-- 2028_campaign_poll_list_pagination.sql
--
-- F14 campaign-poll authoring reads use the immutable `(created_at, id)`
-- keyset. These partial indexes make both the campaign-wide admin list and the
-- exact-revision send-time walk bounded and deterministic without indexing
-- quarantined legacy rows that cannot be used by v3.
--
-- migration-execution: phased
-- rollback-strategy: no-op

SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_campaign_created_id_idx
    ON campaign_polls (tenant_id, campaign_id, created_at, id)
    WHERE content_revision_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_revision_created_id_idx
    ON campaign_polls (
        tenant_id, campaign_id, content_revision_id, created_at, id
    )
    WHERE content_revision_id IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
