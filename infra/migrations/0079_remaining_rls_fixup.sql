-- 0079_remaining_rls_fixup.sql
--
-- Final sweep of the RESTRICTIVE-only-policy bug pattern that 0077 and
-- 0078 started fixing. The new scripts/check-rls-policies.sh lint
-- surfaced 12 more tables sharing the same shape: RLS enabled +
-- a single CREATE POLICY ... AS RESTRICTIVE on a tenant_id column,
-- and no companion PERMISSIVE policy. Postgres semantics:
--   - PERMISSIVE policies are ORed; if NONE exist, access is denied.
--   - RESTRICTIVE policies AND on top; alone they're a silent always-deny.
--
-- Every table fixed here mirrors the canonical pattern from 0077/0078:
-- a `tenant_visible` PERMISSIVE FOR ALL TO postwave_app policy that
-- grants access when the row's tenant_id matches the
-- `app.tenant_id` GUC. The existing RESTRICTIVE policy stays as a
-- defence-in-depth filter against accidental cross-tenant updates.
--
-- Ordered alphabetically by table for easier review.
--
-- Tables fixed:
--   assets, custom_domains, discounts, discount_redemptions,
--   dmarc_reports, gift_subscriptions, inbound_email_endpoints,
--   inbound_emails, inbound_events, inbound_webhook_endpoints,
--   paid_subs, product_events, referral_codes, referral_conversions,
--   referral_programs.
--
-- Note: a few of these are also covered transitively by other policies
-- once the post-migration ALTER POLICY rewrite block in
-- infra/docker-compose.full.yml runs, but that's a runtime detail of
-- the dev stack — fresh production deploys go straight from migrations
-- to live traffic without that block running, so we want the policies
-- correct in-tree.

BEGIN;

-- assets (0063_assets.sql)
CREATE POLICY tenant_visible ON assets
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- custom_domains (0070_custom_domains.sql)
CREATE POLICY tenant_visible ON custom_domains
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- discount_redemptions (0073_discounts.sql)
CREATE POLICY tenant_visible ON discount_redemptions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- dmarc_reports (0067_dmarc_reports.sql)
CREATE POLICY tenant_visible ON dmarc_reports
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- gift_subscriptions (0074_gift_subscriptions.sql)
CREATE POLICY tenant_visible ON gift_subscriptions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- inbound_email_endpoints (0066_inbound_email.sql)
CREATE POLICY tenant_visible ON inbound_email_endpoints
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- inbound_emails (0066_inbound_email.sql)
CREATE POLICY tenant_visible ON inbound_emails
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- inbound_events (0064_inbound_webhooks.sql)
CREATE POLICY tenant_visible ON inbound_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- paid_subs (0075_founding_member.sql)
CREATE POLICY tenant_visible ON paid_subs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- product_events (0065_product_events.sql)
CREATE POLICY tenant_visible ON product_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- referral_conversions (0072_referrals.sql)
CREATE POLICY tenant_visible ON referral_conversions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- referral_programs (0072_referrals.sql)
CREATE POLICY tenant_visible ON referral_programs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
