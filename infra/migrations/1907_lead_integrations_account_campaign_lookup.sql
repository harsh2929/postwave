-- 1907_lead_integrations_account_campaign_lookup.sql
--
-- Eleven lead-capture integrations dropped every webhook they received.
--
-- `FindIntegrationByProviderAccountAndCampaign` resolves an inbound lead
-- webhook to the integration that should receive it. The caller has no session
-- and no tenant — a webhook arrives from the provider, not from a logged-in
-- user — so the transaction sets three GUCs and carries no `app.tenant_id`:
--
--     app.lead_provider, app.lead_account_id, app.lead_campaign_id
--
-- `lead_integrations` has a per-provider webhook policy for wix, typeform,
-- jotform, fillout, webflow and facebook-lead-ads, each keyed on
-- `app.lead_provider` plus a provider-specific identifier. NOTHING reads
-- `app.lead_account_id` or `app.lead_campaign_id`, and none of those six
-- providers uses this lookup.
--
-- The eleven that DO use it have no policy at all:
--
--     convertflow, kickofflabs, landingi, optinmonster, outgrow, poptin,
--     privy, riddle, shortstack, sleeknote, wisepops
--
-- So the query ran with `tenant_id = NULL`, matched nothing, and every webhook
-- from those providers failed to resolve its integration. Silently: a lead that
-- cannot be attributed is not an error anywhere, it is simply a lead that never
-- arrives.
--
-- THE PREDICATE MIRRORS THE QUERY, deliberately. RLS and the WHERE clause must
-- agree on which row a webhook identifies; if the policy were broader the
-- capability would admit rows the lookup does not want, and if it were narrower
-- the lookup would keep returning nothing for some providers and not others —
-- which is harder to notice than failing outright. The account and campaign
-- keys are the same lists the Go query uses, because each provider spells its
-- own identifier differently and there is no single canonical column.
--
-- SELECT ONLY, and scoped by BOTH account and campaign. The provider alone
-- would admit every tenant's integrations for that provider — a cross-tenant
-- read granted to anyone who can name a provider. Requiring the account and the
-- campaign means a webhook resolves the integration it names and no other.

BEGIN;

DROP POLICY IF EXISTS lead_integrations_account_campaign_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_account_campaign_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND status = ANY (ARRAY['connected', 'error', 'needs_auth'])
        AND lower(COALESCE(settings->>'account_id', settings->>'provider_account_id', ''))
            = lower(NULLIF(current_setting('app.lead_account_id', true), ''))
        AND lower(NULLIF(current_setting('app.lead_campaign_id', true), '')) IN (
            lower(COALESCE(settings->>'campaign_id', '')),
            lower(COALESCE(settings->>'campaign', '')),
            lower(COALESCE(settings->>'provider_campaign_id', '')),
            lower(COALESCE(settings->>'popup_id', '')),
            lower(COALESCE(settings->>'poptin_id', '')),
            lower(COALESCE(settings->>'page_id', '')),
            lower(COALESCE(settings->>'landing_page_id', '')),
            lower(COALESCE(settings->>'landingi_page_id', '')),
            lower(COALESCE(settings->>'outgrow_campaign_id', '')),
            lower(COALESCE(settings->>'content_id', '')),
            lower(COALESCE(settings->>'calculator_id', '')),
            lower(COALESCE(settings->>'quiz_id', '')),
            lower(COALESCE(settings->>'riddle_id', '')),
            lower(COALESCE(settings->>'experience_id', ''))
        )
    );

COMMENT ON POLICY lead_integrations_account_campaign_webhook_lookup ON lead_integrations IS
    'The webhook lookup used by convertflow, kickofflabs, landingi, '
    'optinmonster, outgrow, poptin, privy, riddle, shortstack, sleeknote and '
    'wisepops. Those callers have no tenant — a webhook comes from the provider '
    '— so the account and campaign they name are the only credentials '
    'available. Before this the lookup matched the null tenant and every one of '
    'those providers silently dropped its leads. Requires BOTH account and '
    'campaign: provider alone would expose every tenant''s integrations.';

COMMIT;
