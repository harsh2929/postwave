-- 0077_send_domain_rls_fixup.sql
--
-- Two follow-up bugs in migration 0068 (sending domain) that the
-- send-guard worker uncovered:
--
-- 1) RLS bug: 0068 created `tenant_sending_settings`,
--    `tenant_send_rate_buckets`, and `campaign_recipients` with ONLY a
--    `RESTRICTIVE` policy (`tenant_isolation`) and no companion
--    `PERMISSIVE` policy. Postgres requires at least one PERMISSIVE
--    policy for any access to be granted; a RESTRICTIVE policy is an
--    AND-filter on top, not a permit. Result: every INSERT/UPDATE/
--    DELETE under the `postwave_app` role fails with 42501.
--
--    Fix: add a permissive policy that grants the row when the GUC
--    `app.tenant_id` matches `tenant_id`. The existing restrictive
--    policy stays as a defence-in-depth filter against accidentally
--    cross-tenant updates.
--
-- 2) Status enum: 0068 also extended the existing `campaigns` table
--    with `recurrence_*` and `audience_*` columns but didn't widen the
--    `campaigns_status_check` CHECK constraint to allow the new
--    'cancelled' and 'failed' statuses that the X1 send-domain code
--    paths emit. Result: SetStatus(... StatusCancelled) trips the
--    constraint with 23514.
--
--    Fix: drop the old CHECK and add one that includes the new
--    statuses.

BEGIN;

-- ---------------------------------------------------------------------
-- Permissive RLS policies (companion to 0068's restrictive ones).
-- ---------------------------------------------------------------------

CREATE POLICY tenant_visible ON tenant_sending_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_visible ON tenant_send_rate_buckets
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_visible ON campaign_recipients
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------
-- Widen campaigns.status to allow 'cancelled' and 'failed'. The CHECK
-- constraint name comes from migration 0027_campaigns.sql; verify with
-- \d campaigns if the drop fails (some deployments may have
-- regenerated it under a different name).
-- ---------------------------------------------------------------------

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
    CHECK (status IN (
        'draft',
        'scheduled',
        'sending',
        'paused',
        'cancelled',
        'sent',
        'failed'
    ));

COMMIT;
