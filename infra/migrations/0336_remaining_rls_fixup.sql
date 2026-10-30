-- 0336_remaining_rls_fixup.sql
--
-- Third (and hopefully final) round of the RESTRICTIVE-only RLS bug
-- pattern that bit us in 0077_send_domain_rls_fixup.sql and
-- 0078_audience_rls_fixup.sql. scripts/check-rls-policies.sh enumerates
-- the remaining offenders -- 13 tables across the activitypub,
-- compliance, dashboard, form-variants, referrals, deliverability, and
-- webhooks subsystems -- that ship `ENABLE ROW LEVEL SECURITY` + a
-- RESTRICTIVE `tenant_isolation` policy but no companion PERMISSIVE
-- policy. Under FORCE ROW LEVEL SECURITY that combination silently
-- denies every query for the `postwave_app` role (42501).
--
-- Postgres PERMISSIVE/RESTRICTIVE semantics refresher:
--   * PERMISSIVE policies are ORed; a row is visible iff at least one
--     PERMISSIVE policy returns true.
--   * RESTRICTIVE policies are ANDed on top of the PERMISSIVE OR; they
--     filter further but DO NOT GRANT access on their own.
--   * A table with FORCE ROW LEVEL SECURITY enabled and zero PERMISSIVE
--     policies is an always-deny for every non-owner role.
--
-- Fix mirrors 0077/0078: add a canonical PERMISSIVE `tenant_visible`
-- policy that lets `postwave_app` see rows whose `tenant_id` matches
-- the `app.tenant_id` GUC. The existing RESTRICTIVE `tenant_isolation`
-- policies are intentionally left in place as a defence-in-depth filter
-- against accidentally cross-tenant writes.
--
-- Predicate form: cast to text and COALESCE the GUC against the
-- all-zero nil UUID so the policy still evaluates cleanly when the GUC
-- is unset (e.g. during migration application or cross-tenant janitor
-- sweeps the policy is intentionally bypassed by other companion
-- policies). The cast-to-text idiom matches the form already used in
-- 0174/0176/0178/0179 and avoids the raw `::uuid` cast crashing on an
-- unset GUC.
--
-- Tables covered (13, mirroring scripts/check-rls-policies.sh output):
--   * activitypub_delivery_queue          (0287)
--   * activitypub_followers               (0287)
--   * compliance_programs                 (0193)
--   * compliance_program_events           (0193)
--   * dashboard_anomalies                 (0215)
--   * dashboard_digest_prefs              (0216)
--   * dashboard_layouts                   (0217)
--   * form_variant_promotions             (0289)
--   * referral_clicks                     (0327)
--   * referral_program_variants           (0327)
--   * tenant_deliverability_providers     (0327)
--   * webhook_alert_prefs                 (0184)
--   * webhook_test_payloads               (0185)
--
-- Idempotent: every policy is wrapped in DROP POLICY IF EXISTS so this
-- migration is safe to re-apply on tenants that already received a
-- hand-patched fix between 0328 and 0329.

BEGIN;

-- ---------------------------------------------------------------------
-- activitypub_* (from 0287_activitypub_federation.sql)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON activitypub_delivery_queue;
CREATE POLICY tenant_visible ON activitypub_delivery_queue
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON activitypub_followers;
CREATE POLICY tenant_visible ON activitypub_followers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- compliance_* (from 0193_compliance_programs.sql)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON compliance_programs;
CREATE POLICY tenant_visible ON compliance_programs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON compliance_program_events;
CREATE POLICY tenant_visible ON compliance_program_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- dashboard_* (from 0215/0216/0217)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON dashboard_anomalies;
CREATE POLICY tenant_visible ON dashboard_anomalies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON dashboard_digest_prefs;
CREATE POLICY tenant_visible ON dashboard_digest_prefs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON dashboard_layouts;
CREATE POLICY tenant_visible ON dashboard_layouts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- form_variant_promotions (from 0289_form_variants.sql)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON form_variant_promotions;
CREATE POLICY tenant_visible ON form_variant_promotions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- referrals + deliverability (from 0327_referrals_webhooks_completion.sql)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON referral_clicks;
CREATE POLICY tenant_visible ON referral_clicks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON referral_program_variants;
CREATE POLICY tenant_visible ON referral_program_variants
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON tenant_deliverability_providers;
CREATE POLICY tenant_visible ON tenant_deliverability_providers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- webhook_* (from 0184/0185)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON webhook_alert_prefs;
CREATE POLICY tenant_visible ON webhook_alert_prefs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

DROP POLICY IF EXISTS tenant_visible ON webhook_test_payloads;
CREATE POLICY tenant_visible ON webhook_test_payloads
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

COMMIT;
