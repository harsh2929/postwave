-- 1810_landing_page_schedule.sql
-- LAND-038: scheduled publish / auto-unpublish (expire) for landing pages.
-- Two nullable timestamps drive a periodic worker (landingpages.SchedulerWorker,
-- registered in workers/operational_maintenance.go): a draft with publish_at<=now
-- flips to published; a published page with unpublish_at<=now flips back to draft.
-- The worker runs cross-tenant under app.outbox_worker='true' (no tenant GUC), so
-- it needs a permissive RLS escape mirroring slack_integrations (0043).

BEGIN;

ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS publish_at   timestamptz,
    ADD COLUMN IF NOT EXISTS unpublish_at timestamptz;

-- Due-scan indexes: only the small set of scheduled rows in the relevant state.
CREATE INDEX IF NOT EXISTS landing_pages_publish_due_idx
    ON landing_pages (publish_at)
    WHERE status = 'draft' AND publish_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS landing_pages_unpublish_due_idx
    ON landing_pages (unpublish_at)
    WHERE status = 'published' AND unpublish_at IS NOT NULL;

-- Cross-tenant scheduler escape. Same shape as slack_integrations_worker_* (0043):
-- the worker binds app.outbox_worker='true' before its due-scan UPDATEs.
CREATE POLICY landing_pages_worker_select ON landing_pages
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY landing_pages_worker_update ON landing_pages
    AS PERMISSIVE
    FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
