-- 0103_sending_deprovision_jobs.sql
--
-- Grace-period cleanup for managed Postmark servers after tenant downgrade or
-- churn. The tenant's sending_state row is removed immediately so the app
-- stops using managed sending, while this queue preserves the upstream server
-- id for a delayed finance/audit cleanup job.

CREATE TABLE IF NOT EXISTS sending_deprovision_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    postmark_server_id text NOT NULL,
    postmark_stream_id text,
    scheduled_at timestamptz NOT NULL,
    attempted_at timestamptz,
    completed_at timestamptz,
    attempts int NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sending_deprovision_jobs_due_idx
    ON sending_deprovision_jobs (scheduled_at)
    WHERE completed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sending_deprovision_jobs_tenant_server_idx
    ON sending_deprovision_jobs (tenant_id, postmark_server_id)
    WHERE completed_at IS NULL;

CREATE TRIGGER sending_deprovision_jobs_set_updated_at
    BEFORE UPDATE ON sending_deprovision_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON sending_deprovision_jobs TO postwave_app;
