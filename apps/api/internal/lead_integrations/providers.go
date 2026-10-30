// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

func managedLeadProviderSpec(provider, name, authMode string, required, optional []ProviderField, scopes, syncObjects, webhookTopics []string) ProviderSpec {
	requiredSettings := append([]ProviderField(nil), required...)
	requiredSettings = append(requiredSettings, ProviderField{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing " + name + " API or OAuth credentials"})
	optionalSettings := append([]ProviderField(nil), optional...)
	optionalSettings = append(optionalSettings,
		ProviderField{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported onsite leads"},
		ProviderField{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
	)
	return ProviderSpec{
		Provider:         provider,
		Name:             name,
		Category:         "forms",
		AuthMode:         authMode,
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        leadSyncModelIngest,
		VerificationMode: leadVerificationMode(provider),
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: requiredSettings,
		OptionalSettings: optionalSettings,
		Scopes:           scopes,
		SyncObjects:      syncObjects,
		WebhookTopics:    webhookTopics,
		DocsURL:          "/docs/integrations/" + provider,
	}
}

var providerSpecs = []ProviderSpec{
	{
		Provider:         ProviderTypeform,
		Name:             "Typeform",
		Category:         "forms",
		AuthMode:         "personal_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "typeform_responses_webhook_backfill",
		VerificationMode: "typeform_hmac_sha256",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Typeform form identifier to sync or receive submissions for"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Typeform token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Typeform leads"},
			{Key: "webhook_secret_ref", Label: "Webhook signing-secret reference", Secret: true, Help: "Vault reference containing the Typeform webhook secret used for Typeform-Signature validation"},
			{Key: "api_region", Label: "API region", Help: "Use eu for forms whose responses live in Typeform's EU response data center"},
			{Key: "responses_api_region", Label: "Responses API region", Help: "Optional override for response retrieval region when the form metadata response does not include _links.responses"},
			{Key: "response_type", Label: "Response type", Help: "completed by default; partial can be enabled for partial-response ingestion"},
			{Key: "page_size", Label: "Page size", Help: "Responses API page size, capped at Typeform's documented maximum of 1000"},
			{Key: "webhook_tag", Label: "Webhook tag", Help: "Provider webhook tag used when reconciling a Moosewave-owned Typeform webhook"},
			{Key: "verify_ssl", Label: "Verify SSL", Help: "Set to false only for explicitly approved non-production webhook endpoints; defaults to true"},
			{Key: "include_partial_responses", Label: "Include partial webhook responses", Help: "Set true to subscribe the managed Typeform webhook to form_response_partial events"},
		},
		Scopes:        []string{"forms:read", "responses:read", "webhooks:read", "webhooks:write"},
		SyncObjects:   []string{"forms", "responses"},
		WebhookTopics: []string{"form_response"},
		DocsURL:       "/docs/integrations/typeform",
	},
	{
		Provider:         ProviderJotform,
		Name:             "Jotform",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "jotform_submissions_webhook_backfill",
		VerificationMode: "postwave_shared_secret",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Jotform form identifier to sync"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Jotform API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Jotform leads"},
			{Key: "webhook_secret_ref", Label: "Webhook token reference", Secret: true, Help: "Vault reference containing the Moosewave-owned token Jotform sends with webhooks"},
			{Key: "api_region", Label: "API region", Help: "Use eu or hipaa for Jotform regional API hosts"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Jotform API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API page size, capped at 1000"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when webhook payloads omit form metadata"},
		},
		Scopes:        []string{"forms:read", "submissions:read", "webhooks:write"},
		SyncObjects:   []string{"forms", "questions", "submissions"},
		WebhookTopics: []string{"submission.created"},
		DocsURL:       "/docs/integrations/jotform",
	},
	{
		Provider:         ProviderTally,
		Name:             "Tally",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "tally_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "tally_submissions_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Tally form identifier to sync submissions from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Tally API key or Bearer token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Tally leads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Tally API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API page size, capped at Tally's documented maximum of 500"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when submission payloads omit form metadata"},
		},
		Scopes:      []string{"forms:read", "submissions:read"},
		SyncObjects: []string{"forms", "submissions"},
		DocsURL:     "/docs/integrations/tally",
	},
	{
		Provider:         ProviderGoogleForms,
		Name:             "Google Forms",
		Category:         "forms",
		AuthMode:         "oauth_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "google_forms_responses_rest_backfill_scheduled_retry",
		VerificationMode: "google_forms_responses_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Google Forms identifier to sync responses from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Google OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Google Forms leads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Google Forms API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Responses API page size, capped at Google's documented maximum of 5000"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when form metadata is unavailable"},
			{Key: "after_time", Label: "After time", Help: "Optional RFC3339 UTC timestamp lower-bound filter"},
			{Key: "email_question_id", Label: "Email question ID", Help: "Optional Google Forms question ID used for email identity mapping"},
			{Key: "first_name_question_id", Label: "First name question ID", Help: "Optional Google Forms question ID used for first-name mapping"},
			{Key: "last_name_question_id", Label: "Last name question ID", Help: "Optional Google Forms question ID used for last-name mapping"},
			{Key: "full_name_question_id", Label: "Full name question ID", Help: "Optional Google Forms question ID used for full-name mapping"},
			{Key: "phone_question_id", Label: "Phone question ID", Help: "Optional Google Forms question ID used for phone mapping"},
			{Key: "company_question_id", Label: "Company question ID", Help: "Optional Google Forms question ID used for company mapping"},
		},
		Scopes:      []string{"forms.body.readonly", "forms.responses.readonly"},
		SyncObjects: []string{"forms", "responses"},
		DocsURL:     "/docs/integrations/google-forms",
	},
	{
		Provider:      ProviderMicrosoftForms,
		Name:          "Microsoft Forms",
		Category:      "forms",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Microsoft Forms identifier to sync responses from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Microsoft OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "tenant_id", Label: "Microsoft tenant ID", Help: "Optional Microsoft Entra tenant identifier"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Microsoft Forms leads"},
		},
		Scopes:        []string{"forms.read", "responses.read", "offline_access"},
		SyncObjects:   []string{"forms", "responses", "questions"},
		WebhookTopics: []string{"form_response"},
		DocsURL:       "/docs/integrations/microsoft-forms",
	},
	{
		Provider:         ProviderSurveyMonkey,
		Name:             "SurveyMonkey",
		Category:         "forms",
		AuthMode:         "oauth_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "surveymonkey_responses_bulk_rest_backfill_scheduled_retry",
		VerificationMode: "surveymonkey_responses_bulk_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "survey_id", Label: "Survey ID", Required: true, Help: "SurveyMonkey survey identifier to sync responses from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing SurveyMonkey OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "collector_id", Label: "Collector ID", Help: "Optional collector filter for response sync"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional SurveyMonkey API base URL override"},
			{Key: "page_size", Label: "Page size", Help: "Responses API per_page size, capped at SurveyMonkey's documented maximum of 100"},
			{Key: "survey_name", Label: "Survey name", Help: "Optional display name applied to imported responses"},
			{Key: "start_modified_at", Label: "Start modified at", Help: "Optional lower-bound modified timestamp for responses"},
			{Key: "end_modified_at", Label: "End modified at", Help: "Optional upper-bound modified timestamp for responses"},
			{Key: "start_created_at", Label: "Start created at", Help: "Optional lower-bound creation timestamp"},
			{Key: "end_created_at", Label: "End created at", Help: "Optional upper-bound creation timestamp"},
			{Key: "status", Label: "Response status", Help: "Optional response status filter"},
			{Key: "email_question_id", Label: "Email question ID", Help: "Optional SurveyMonkey question ID used for email identity mapping"},
			{Key: "first_name_question_id", Label: "First name question ID", Help: "Optional SurveyMonkey question ID used for first-name mapping"},
			{Key: "last_name_question_id", Label: "Last name question ID", Help: "Optional SurveyMonkey question ID used for last-name mapping"},
			{Key: "full_name_question_id", Label: "Full name question ID", Help: "Optional SurveyMonkey question ID used for full-name mapping"},
			{Key: "phone_question_id", Label: "Phone question ID", Help: "Optional SurveyMonkey question ID used for phone mapping"},
			{Key: "company_question_id", Label: "Company question ID", Help: "Optional SurveyMonkey question ID used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported SurveyMonkey leads"},
		},
		Scopes:      []string{"surveys_read_detail", "responses_read_detail"},
		SyncObjects: []string{"surveys", "collectors", "questions", "responses"},
		DocsURL:     "/docs/integrations/surveymonkey",
	},
	{
		Provider:         ProviderFacebookLeadAds,
		Name:             "Facebook Lead Ads",
		Category:         "ads",
		AuthMode:         "oauth_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "facebook_lead_ads_leads_rest_webhook_backfill",
		VerificationMode: "meta_graph_oauth_ref_hub_signature_sha256",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "page_id", Label: "Page ID", Required: true, Help: "Meta Page identifier that owns the lead form"},
			{Key: "form_id", Label: "Lead form ID", Required: true, Help: "Facebook Lead Ads form identifier to sync or receive leads from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Meta OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "ad_account_id", Label: "Ad account ID", Help: "Optional Meta ad account for campaign attribution"},
			{Key: "webhook_secret_ref", Label: "Meta app secret reference", Secret: true, Help: "Vault reference containing the Meta app secret used for X-Hub-Signature-256 verification"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"leads_retrieval", "pages_read_engagement", "pages_manage_metadata", "ads_read"},
		SyncObjects:   []string{"leads"},
		WebhookTopics: []string{"leadgen"},
		DocsURL:       "/docs/integrations/facebook-lead-ads",
	},
	{
		Provider:      ProviderLinkedInLeadGen,
		Name:          "LinkedIn Lead Gen Forms",
		Category:      "ads",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "ad_account_id", Label: "Ad account ID", Required: true, Help: "LinkedIn ad account identifier that owns the lead form"},
			{Key: "form_id", Label: "Lead Gen Form ID", Required: true, Help: "LinkedIn Lead Gen Form identifier to sync or receive leads from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing LinkedIn OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Help: "Optional LinkedIn organization identifier for attribution"},
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for lead attribution"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"r_ads", "r_ads_leadgen_automation", "rw_ads"},
		SyncObjects:   []string{"lead_forms", "leads", "ad_accounts", "campaigns", "organizations"},
		WebhookTopics: []string{"lead.created"},
		DocsURL:       "/docs/integrations/linkedin-lead-gen",
	},
	{
		Provider:         ProviderGoogleLeadForms,
		Name:             "Google Lead Form Extensions",
		Category:         "ads",
		AuthMode:         "oauth_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "google_lead_forms_google_ads_search_backfill",
		VerificationMode: "google_ads_oauth_developer_token_ref",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "customer_id", Label: "Customer ID", Required: true, Help: "Google Ads customer ID that owns the lead form asset"},
			{Key: "lead_form_asset_id", Label: "Lead form asset ID", Required: true, Help: "Google Ads lead form asset identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Google Ads OAuth access token and developer token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for attribution"},
			{Key: "login_customer_id", Label: "Manager customer ID", Help: "Optional MCC login-customer-id used when the OAuth identity is a manager account"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name for imported lead submissions"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:      []string{"adwords", "offline_access"},
		SyncObjects: []string{"lead_form_submission_data"},
		DocsURL:     "/docs/integrations/google-lead-form-extensions",
	},
	{
		Provider:      ProviderTikTokLeadGen,
		Name:          "TikTok Lead Generation",
		Category:      "ads",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "advertiser_id", Label: "Advertiser ID", Required: true, Help: "TikTok Ads advertiser account identifier"},
			{Key: "form_id", Label: "Instant Form ID", Required: true, Help: "TikTok lead generation form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing TikTok Ads OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for lead attribution"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"advertiser.info", "lead.read", "campaign.read"},
		SyncObjects:   []string{"instant_forms", "leads", "advertisers", "campaigns", "adgroups", "ads"},
		WebhookTopics: []string{"lead.generated"},
		DocsURL:       "/docs/integrations/tiktok-lead-generation",
	},
	{
		Provider:      ProviderSnapLeadAds,
		Name:          "Snap Lead Ads",
		Category:      "ads",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "ad_account_id", Label: "Ad account ID", Required: true, Help: "Snap Ads account identifier that owns the lead form"},
			{Key: "form_id", Label: "Lead form ID", Required: true, Help: "Snap lead form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Snap Ads OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Help: "Optional Snap organization identifier"},
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for lead attribution"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"snap_ads.read", "lead_generation.read"},
		SyncObjects:   []string{"lead_forms", "leads", "ad_accounts", "campaigns", "ad_squads", "ads"},
		WebhookTopics: []string{"lead.created"},
		DocsURL:       "/docs/integrations/snap-lead-ads",
	},
	{
		Provider:      ProviderRedditLeadGen,
		Name:          "Reddit Lead Gen",
		Category:      "ads",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "ad_account_id", Label: "Ad account ID", Required: true, Help: "Reddit Ads account identifier that owns the lead form"},
			{Key: "form_id", Label: "Lead form ID", Required: true, Help: "Reddit lead generation form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Reddit Ads OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for lead attribution"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"adsread", "lead_generation.read"},
		SyncObjects:   []string{"lead_forms", "leads", "ad_accounts", "campaigns", "ad_groups", "ads"},
		WebhookTopics: []string{"lead.created"},
		DocsURL:       "/docs/integrations/reddit-lead-gen",
	},
	{
		Provider:      ProviderPinterestLeads,
		Name:          "Pinterest Lead Ads",
		Category:      "ads",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "ad_account_id", Label: "Ad account ID", Required: true, Help: "Pinterest Ads account identifier that owns the lead form"},
			{Key: "form_id", Label: "Lead form ID", Required: true, Help: "Pinterest lead form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Pinterest Ads OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign filter for lead attribution"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ad leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"ads:read", "leads:read"},
		SyncObjects:   []string{"lead_forms", "leads", "ad_accounts", "campaigns", "ad_groups", "ads"},
		WebhookTopics: []string{"lead.created"},
		DocsURL:       "/docs/integrations/pinterest-lead-ads",
	},
	{
		Provider:         ProviderUnbounce,
		Name:             "Unbounce",
		Category:         "forms",
		AuthMode:         "oauth_or_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "unbounce_leads_rest_backfill_scheduled_retry",
		VerificationMode: "unbounce_leads_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "page_id", Label: "Page ID", Required: true, Help: "Unbounce landing page identifier to sync leads from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing an Unbounce OAuth access token or API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "client_id", Label: "Client ID", Help: "Optional Unbounce client or workspace identifier"},
			{Key: "form_id", Label: "Form ID", Help: "Optional form identifier when a page has multiple forms"},
			{Key: "page_name", Label: "Page name", Help: "Optional display name for imported Unbounce leads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Unbounce API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Leads API limit size, capped at Unbounce's documented maximum of 1000"},
			{Key: "from", Label: "From timestamp", Help: "Optional UTC lower-bound filter for lead creation time"},
			{Key: "to", Label: "To timestamp", Help: "Optional UTC upper-bound filter for lead creation time"},
			{Key: "include_sub_pages", Label: "Include sub pages", Help: "Optional form-field metadata flag for sub pages"},
			{Key: "email_field_id", Label: "Email field ID", Help: "Optional Unbounce form field ID used for email identity mapping"},
			{Key: "first_name_field_id", Label: "First name field ID", Help: "Optional Unbounce form field ID used for first-name mapping"},
			{Key: "last_name_field_id", Label: "Last name field ID", Help: "Optional Unbounce form field ID used for last-name mapping"},
			{Key: "full_name_field_id", Label: "Full name field ID", Help: "Optional Unbounce form field ID used for full-name mapping"},
			{Key: "phone_field_id", Label: "Phone field ID", Help: "Optional Unbounce form field ID used for phone mapping"},
			{Key: "company_field_id", Label: "Company field ID", Help: "Optional Unbounce form field ID used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported landing-page leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:      []string{"pages:read", "leads:read"},
		SyncObjects: []string{"pages", "form_fields", "leads"},
		DocsURL:     "/docs/integrations/unbounce",
	},
	{
		Provider:         ProviderLeadpages,
		Name:             "Leadpages",
		Category:         "forms",
		AuthMode:         "bearer_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "leadpages_form_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "leadpages_form_submissions_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Leadpages form identifier used for /api/forms/{form_id}/submissions"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing a Leadpages API key or OAuth access token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional Leadpages account identifier for operator context"},
			{Key: "page_id", Label: "Page ID", Help: "Optional Leadpages landing page identifier stored on imported leads"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name for imported Leadpages submissions"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Leadpages API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Local request limit, capped at 250 until live Leadpages pagination limits are certified"},
			{Key: "from", Label: "From timestamp", Help: "Optional lower-bound filter passed to the provider when supported"},
			{Key: "to", Label: "To timestamp", Help: "Optional upper-bound filter passed to the provider when supported"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional field key used for email identity mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional field key used for first-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional field key used for last-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional field key used for full-name mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional field key used for phone mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional field key used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported landing-page leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:      []string{"forms.read", "submissions.read"},
		SyncObjects: []string{"forms", "submissions"},
		DocsURL:     "/docs/integrations/leadpages",
	},
	{
		Provider:         ProviderInstapage,
		Name:             "Instapage",
		Category:         "forms",
		AuthMode:         "bearer_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "instapage_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "instapage_submissions_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Instapage workspace identifier"},
			{Key: "page_id", Label: "Page ID", Required: true, Help: "Instapage landing page identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing an Instapage personal API token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_name", Label: "Page name", Help: "Optional Instapage landing-page label stored on imported submissions"},
			{Key: "form_id", Label: "Form ID", Help: "Optional Moosewave form identifier for imported submissions"},
			{Key: "api_base_url", Label: "API base URL", Help: "Override for Instapage API host when certifying a regional or sandbox endpoint"},
			{Key: "from", Label: "Created from", Help: "Optional Unix-second or RFC3339 lower bound for submissions"},
			{Key: "to", Label: "Created to", Help: "Optional Unix-second or RFC3339 upper bound for submissions"},
			{Key: "email_field", Label: "Email field", Help: "Optional field key to map to the canonical email identity"},
			{Key: "first_name_field", Label: "First name field", Help: "Optional field key to map to first name"},
			{Key: "last_name_field", Label: "Last name field", Help: "Optional field key to map to last name"},
			{Key: "phone_field", Label: "Phone field", Help: "Optional field key to map to phone"},
			{Key: "company_field", Label: "Company field", Help: "Optional field key to map to company"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported landing-page leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:      []string{"pages.read", "submissions.read"},
		SyncObjects: []string{"workspaces", "pages", "submissions"},
		DocsURL:     "/docs/integrations/instapage",
	},
	{
		Provider:         ProviderCarrd,
		Name:             "Carrd",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "carrd_custom_url_form_webhook_ingest",
		VerificationMode: "carrd_custom_url_route_token_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Stable Carrd site identifier included in the Custom URL query string, header, or hidden field"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Carrd form identifier, form label, or hidden field value used for routing"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave Carrd Custom URL route token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_name", Label: "Form name", Help: "Optional display name stored on imported Carrd leads"},
			{Key: "email_field_key", Label: "Email field", Help: "Optional Carrd field label to map to the canonical email identity"},
			{Key: "first_name_field_key", Label: "First name field", Help: "Optional Carrd field label to map to first name"},
			{Key: "last_name_field_key", Label: "Last name field", Help: "Optional Carrd field label to map to last name"},
			{Key: "full_name_field_key", Label: "Full name field", Help: "Optional Carrd field label to map to full name"},
			{Key: "phone_field_key", Label: "Phone field", Help: "Optional Carrd field label to map to phone"},
			{Key: "company_field_key", Label: "Company field", Help: "Optional Carrd field label to map to company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field", Help: "Optional Carrd field label containing an RFC3339 or SQL-style submission timestamp"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Carrd leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:        []string{"custom_url_form.configure", "route_token.verify"},
		SyncObjects:   []string{"sites", "forms", "custom_url_submissions"},
		WebhookTopics: []string{"form.submitted"},
		DocsURL:       "/docs/integrations/carrd",
	},
	{
		Provider:         ProviderPaperform,
		Name:             "Paperform",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "paperform_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "paperform_submissions_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Paperform form slug, custom slug, or ID to sync submissions from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Paperform API key or Bearer token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported form leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Paperform API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API page size, capped at Paperform's documented maximum of 100"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when submission payloads omit form metadata"},
			{Key: "after_date", Label: "After date", Help: "Optional UTC lower-bound filter for submitted entries"},
			{Key: "before_date", Label: "Before date", Help: "Optional UTC upper-bound filter for submitted entries"},
		},
		Scopes:      []string{"forms:read", "submissions:read"},
		SyncObjects: []string{"forms", "submissions"},
		DocsURL:     "/docs/integrations/paperform",
	},
	{
		Provider:         ProviderFormstack,
		Name:             "Formstack",
		Category:         "forms",
		AuthMode:         "personal_access_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "formstack_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "formstack_submissions_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Formstack form identifier to sync submissions from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Formstack Personal Access Token or Bearer token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported form leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Formstack API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API page size, capped at Formstack's documented maximum of 100 for this runtime"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when submission payloads omit form metadata"},
			{Key: "minTime", Label: "Minimum time", Help: "Optional Formstack Eastern-time lower-bound filter"},
			{Key: "maxTime", Label: "Maximum time", Help: "Optional Formstack Eastern-time upper-bound filter"},
		},
		Scopes:      []string{"forms:read", "submissions:read"},
		SyncObjects: []string{"forms", "submissions"},
		DocsURL:     "/docs/integrations/formstack",
	},
	{
		Provider:         ProviderFillout,
		Name:             "Fillout",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "fillout_submissions_webhook_backfill",
		VerificationMode: "postwave_url_token",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Fillout form identifier to sync or receive submissions for"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Fillout API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional Fillout workspace identifier"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Fillout leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Fillout leads"},
			{Key: "webhook_secret_ref", Label: "Webhook token reference", Secret: true, Help: "Vault reference containing the Moosewave-owned token Fillout sends with webhooks"},
			{Key: "api_region", Label: "API region", Help: "Use eu for Fillout EU-hosted accounts"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for self-hosted or proxied Fillout API hosts"},
			{Key: "page_size", Label: "Page size", Help: "Fillout submissions page size, capped at Fillout's documented maximum of 150"},
			{Key: "status", Label: "Submission status", Help: "Optional Fillout submission status filter"},
			{Key: "afterDate", Label: "After date", Help: "Optional lower submission-time bound passed to Fillout"},
			{Key: "beforeDate", Label: "Before date", Help: "Optional upper submission-time bound passed to Fillout"},
			{Key: "includePreview", Label: "Include preview", Help: "Whether Fillout preview submissions should be included"},
			{Key: "includeEditLink", Label: "Include edit link", Help: "Whether Fillout edit links should be included"},
			{Key: "sort", Label: "Sort", Help: "Fillout submission sort direction"},
			{Key: "search", Label: "Search", Help: "Optional Fillout submission search filter"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when webhook payloads omit form metadata"},
		},
		Scopes:        []string{"forms.read", "submissions.read", "webhooks.write"},
		SyncObjects:   []string{"forms", "metadata", "submissions"},
		WebhookTopics: []string{"submission.created"},
		DocsURL:       "/docs/integrations/fillout",
	},
	{
		Provider:         ProviderOptinMonster,
		Name:             "OptinMonster",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "optinmonster_webhook_ingest",
		VerificationMode: "optinmonster_webhook_route_token_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "OptinMonster account identifier used to route incoming Webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "OptinMonster campaign identifier used to route incoming Webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the OptinMonster Webhook URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional site identifier for operator evidence and filtering"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when webhook payloads omit campaign metadata"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name alias for the OptinMonster campaign"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported OptinMonster leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported OptinMonster leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook lead field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook lead field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook lead field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook lead field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook lead field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook lead field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhook.configure", "route_token.verify"},
		SyncObjects:   []string{"accounts", "campaigns", "leads", "conversions"},
		WebhookTopics: []string{"lead.created", "campaign.converted"},
		DocsURL:       "/docs/integrations/optinmonster",
	},
	{
		Provider:         ProviderPrivy,
		Name:             "Privy",
		Category:         "forms",
		AuthMode:         "basic_auth_ref_webhook",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "privy_custom_webhook_ingest",
		VerificationMode: "privy_basic_auth_custom_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Privy account or site identifier used to route custom webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Privy campaign or display identifier used to route custom webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Basic auth username/password configured on the Privy custom webhook"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional site or store identifier for operator evidence and filtering"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when webhook payloads omit campaign metadata"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name alias for the Privy campaign or display"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Privy signups"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Privy signups"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook signup field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook signup field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook signup field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook signup field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook signup field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook signup field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"custom_webhook.configure", "basic_auth.verify"},
		SyncObjects:   []string{"accounts", "campaigns", "displays", "signups", "contacts", "coupons"},
		WebhookTopics: []string{"signup.created", "contact.created", "coupon.redeemed"},
		DocsURL:       "/docs/integrations/privy",
	},
	{
		Provider:         ProviderConvertFlow,
		Name:             "ConvertFlow",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "convertflow_custom_webhook_ingest",
		VerificationMode: "convertflow_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "ConvertFlow account or site identifier used to route custom webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "ConvertFlow campaign, CTA, or form identifier used to route custom webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the ConvertFlow webhook automation URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional ConvertFlow site identifier for operator evidence and filtering"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign, CTA, or form display name when webhook payloads omit campaign metadata"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name alias for the ConvertFlow CTA or form"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ConvertFlow leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported ConvertFlow leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhook_automation.configure", "route_token.verify"},
		SyncObjects:   []string{"sites", "ctas", "forms", "contacts", "submissions", "webhook_automations"},
		WebhookTopics: []string{"fields.submitted", "contact.updated", "cta.converted", "webhook.automation"},
		DocsURL:       "/docs/integrations/convertflow",
	},
	{
		Provider:         ProviderSleeknote,
		Name:             "Sleeknote",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "sleeknote_custom_integration_ingest",
		VerificationMode: "sleeknote_route_token_custom_integration_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Sleeknote customer or account identifier used to route custom integration deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Sleeknote campaign or SleeknoteId used to route custom integration deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the Sleeknote custom integration URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional site identifier for operator evidence and campaign filtering"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when custom integration payloads omit SignupPage"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name alias for the Sleeknote campaign"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Sleeknote signups"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Sleeknote signups"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional custom integration field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional custom integration field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional custom integration field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional custom integration field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional custom integration field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional custom integration field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional custom integration field key to use for submission time"},
		},
		Scopes:        []string{"custom_integration.configure", "route_token.verify"},
		SyncObjects:   []string{"sites", "campaigns", "forms", "signups", "custom_integrations"},
		WebhookTopics: []string{"signup.created", "campaign.converted", "custom_integration.delivery"},
		DocsURL:       "/docs/integrations/sleeknote",
	},
	{
		Provider:         ProviderWisepops,
		Name:             "Wisepops",
		Category:         "forms",
		AuthMode:         "api_key_ref_hmac_webhook",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "wisepops_signed_webhook_ingest",
		VerificationMode: "wisepops_hmac_sha256_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Wisepops account or site identifier used to route signed webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Wisepops campaign/wisepop identifier used to route signed webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Wisepops API key used to verify X-Wisepops-Signature"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional website identifier for operator evidence and filtering"},
			{Key: "hook_id", Label: "Hook ID", Help: "Optional Wisepops hook identifier for cleanup evidence"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when webhook payloads omit campaign metadata"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name alias for the Wisepops campaign"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Wisepops leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Wisepops leads"},
			{Key: "hook_event", Label: "Hook event", Help: "Optional expected Wisepops hook event such as email, phone, or survey"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"api_key.verify", "webhook.signature.verify", "hooks.configure"},
		SyncObjects:   []string{"sites", "wisepops", "hooks", "contacts"},
		WebhookTopics: []string{"email.collected", "phone.collected", "survey.collected"},
		DocsURL:       "/docs/integrations/wisepops",
	},
	{
		Provider:         ProviderPoptin,
		Name:             "Poptin",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "poptin_webhook_ingest",
		VerificationMode: "poptin_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Poptin account identifier used to route webhook deliveries"},
			{Key: "popup_id", Label: "Popup ID", Required: true, Help: "Poptin popup, form, or campaign identifier used to route webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the Poptin Webhooks integration URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Help: "Optional domain or site identifier for operator evidence"},
			{Key: "popup_name", Label: "Popup name", Help: "Optional popup display name when webhook payloads omit popup metadata"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name alias"},
			{Key: "form_name", Label: "Form name", Help: "Optional form display name alias"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Poptin leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Poptin leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "route_token.verify"},
		SyncObjects:   []string{"sites", "popups", "forms", "leads", "webhook_integrations"},
		WebhookTopics: []string{"lead.created", "popup.converted", "webhook.delivery"},
		DocsURL:       "/docs/integrations/poptin",
	},
	{
		Provider:         ProviderHelloBar,
		Name:             "Hello Bar",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "hello_bar_webhook_ingest",
		VerificationMode: "hello_bar_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Hello Bar site identifier used to route webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Hello Bar bar, popup, form, or campaign identifier used to route webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the Hello Bar Webhook URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional Hello Bar account identifier for operator evidence"},
			{Key: "bar_name", Label: "Bar name", Help: "Optional Hello Bar display name when webhook payloads omit bar metadata"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name alias"},
			{Key: "form_name", Label: "Form name", Help: "Optional form display name alias"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Hello Bar leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Hello Bar leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "route_token.verify"},
		SyncObjects:   []string{"sites", "bars", "campaigns", "subscribers", "webhook_integrations"},
		WebhookTopics: []string{"lead.created", "subscriber.created", "bar.converted", "webhook.delivery"},
		DocsURL:       "/docs/integrations/hello-bar",
	},
	managedLeadProviderSpec(
		ProviderUnstack,
		"Unstack",
		"api_key_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Unstack site identifier"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Unstack form or conversion point identifier"},
		},
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional Unstack workspace identifier"},
		},
		[]string{"sites.read", "forms.read", "submissions.read"},
		[]string{"sites", "pages", "forms", "submissions"},
		[]string{"form.submitted"},
	),
	{
		Provider:         ProviderLandingi,
		Name:             "Landingi",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "landingi_webhook_ingest",
		VerificationMode: "landingi_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Landingi account identifier used to route webhook deliveries"},
			{Key: "page_id", Label: "Page ID", Required: true, Help: "Landingi landing page identifier used to route webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the Landingi Webhook URL or request header"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Help: "Optional Landingi form identifier"},
			{Key: "page_name", Label: "Page name", Help: "Optional landing page display name"},
			{Key: "form_name", Label: "Form name", Help: "Optional form display name"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Landingi leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Landingi leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "route_token.verify"},
		SyncObjects:   []string{"landing_pages", "forms", "leads", "webhook_integrations"},
		WebhookTopics: []string{"lead.created", "form.submitted", "webhook.delivery"},
		DocsURL:       "/docs/integrations/landingi",
	},
	{
		Provider:         ProviderKickoffLabs,
		Name:             "KickoffLabs",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "kickofflabs_webhook_ingest",
		VerificationMode: "kickofflabs_route_token_outbound_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "KickoffLabs account identifier used to route outbound webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "KickoffLabs campaign identifier used to route lead, referral, and reward deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave-owned route token configured on the KickoffLabs outbound Webhook URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_id", Label: "Page ID", Help: "Optional KickoffLabs landing page identifier"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when webhook payloads omit campaign metadata"},
			{Key: "page_name", Label: "Page name", Help: "Optional landing page display name"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported KickoffLabs leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported KickoffLabs leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "route_token.verify"},
		SyncObjects:   []string{"campaigns", "pages", "leads", "referrals", "rewards", "webhook_integrations"},
		WebhookTopics: []string{"lead.created", "referral.created", "reward.earned", "webhook.delivery"},
		DocsURL:       "/docs/integrations/kickofflabs",
	},
	{
		Provider:         ProviderShortStack,
		Name:             "ShortStack",
		Category:         "forms",
		AuthMode:         "webhook_secret_ref_hmac_sha1",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "shortstack_signed_webhook_ingest",
		VerificationMode: "shortstack_x_ss_signature_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "ShortStack account identifier used to route webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "ShortStack campaign, contest, or giveaway identifier used to route webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the ShortStack Webhook form integration secret key used for X-SS-Signature verification"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Help: "Optional ShortStack entry form identifier"},
			{Key: "form_name", Label: "Form name", Help: "Optional form display name when webhook payloads omit form metadata"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported ShortStack entries"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported ShortStack entries"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "webhook_secret.verify"},
		SyncObjects:   []string{"campaigns", "forms", "entries", "leads", "webhook_integrations"},
		WebhookTopics: []string{"entry.created", "lead.created", "webhook.delivery"},
		DocsURL:       "/docs/integrations/shortstack",
	},
	{
		Provider:         ProviderFormsite,
		Name:             "Formsite",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "formsite_results_rest_backfill_scheduled_retry",
		VerificationMode: "formsite_results_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Required: true, Help: "Formsite API base URL from Settings -> Integrations -> Formsite API, for example https://fs1.formsite.com/api/v2"},
			{Key: "account_id", Label: "User directory", Required: true, Help: "Formsite user_dir value from the form URL or API page"},
			{Key: "form_id", Label: "Form directory", Required: true, Help: "Formsite form_dir value to sync results from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Formsite access token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported form leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "page_size", Label: "Page size", Help: "Results API page size, capped at Formsite's documented maximum of 500"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when result payloads omit form metadata"},
			{Key: "after_date", Label: "After date", Help: "Optional UTC lower-bound filter for finished results"},
			{Key: "before_date", Label: "Before date", Help: "Optional UTC upper-bound filter for finished results"},
			{Key: "after_id", Label: "After result ID", Help: "Optional lower-bound Formsite result ID filter"},
			{Key: "before_id", Label: "Before result ID", Help: "Optional upper-bound Formsite result ID filter"},
			{Key: "results_view", Label: "Results View", Help: "Optional Formsite Results View ID to apply"},
			{Key: "email_item_id", Label: "Email item ID", Help: "Optional Formsite item ID used for email identity mapping"},
			{Key: "first_name_item_id", Label: "First name item ID", Help: "Optional Formsite item ID used for first-name mapping"},
			{Key: "last_name_item_id", Label: "Last name item ID", Help: "Optional Formsite item ID used for last-name mapping"},
			{Key: "full_name_item_id", Label: "Full name item ID", Help: "Optional Formsite item ID used for full-name mapping"},
			{Key: "phone_item_id", Label: "Phone item ID", Help: "Optional Formsite item ID used for phone mapping"},
			{Key: "company_item_id", Label: "Company item ID", Help: "Optional Formsite item ID used for company mapping"},
		},
		Scopes:      []string{"forms:read", "results:read"},
		SyncObjects: []string{"forms", "items", "results"},
		DocsURL:     "/docs/integrations/formsite",
	},
	{
		Provider:         ProviderCognitoForms,
		Name:             "Cognito Forms",
		Category:         "forms",
		AuthMode:         "api_key_bearer_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "cognito_forms_odata_entries_backfill_scheduled_retry",
		VerificationMode: "cognito_forms_odata_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Cognito Forms form identifier"},
			{Key: "view_id", Label: "View ID", Required: true, Help: "Cognito Forms grid view ID used for OData entry discovery"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing a Cognito Forms API key with Form:Read and Entry:Read scopes"},
		},
		OptionalSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Help: "Optional organization identifier retained for operator evidence"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name when the provider payload omits form metadata"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Cognito Forms leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "page_size", Label: "Local ID batch size", Help: "Number of OData-discovered entry IDs hydrated per pull, capped at 50 to respect Cognito Forms rate limits"},
			{Key: "api_base_url", Label: "REST API base URL", Help: "Optional Cognito Forms REST API base URL override, defaults to https://www.cognitoforms.com/api"},
			{Key: "odata_base_url", Label: "OData API base URL", Help: "Optional Cognito Forms OData API base URL override, defaults to https://www.cognitoforms.com/api/odata"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional Cognito Forms field/internal name used for email identity mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional Cognito Forms field/internal name used for first-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional Cognito Forms field/internal name used for last-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional Cognito Forms field/internal name used for full-name mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional Cognito Forms field/internal name used for phone mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional Cognito Forms field/internal name used for company mapping"},
		},
		Scopes:      []string{"Form:Read", "Entry:Read"},
		SyncObjects: []string{"forms", "views", "entries", "schema"},
		DocsURL:     "/docs/integrations/cognito-forms",
	},
	{
		Provider:         ProviderNinjaForms,
		Name:             "Ninja Forms",
		Category:         "forms",
		AuthMode:         "webhook_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "ninja_forms_webhook_ingest",
		VerificationMode: "ninja_forms_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_url", Label: "Site URL", Required: true, Help: "WordPress site URL hosting Ninja Forms"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Ninja Forms form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave route token configured in the Ninja Forms Webhooks action"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_name", Label: "Form name", Help: "Optional display name when the webhook payload omits form metadata"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Ninja Forms leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional Ninja Forms field key used for email identity mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional Ninja Forms field key used for first-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional Ninja Forms field key used for last-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional Ninja Forms field key used for full-name mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional Ninja Forms field key used for phone mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional Ninja Forms field key used for company mapping"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional Ninja Forms field key used for submitted-at mapping"},
		},
		Scopes:        []string{"webhooks.configure", "route_token.verify"},
		SyncObjects:   []string{"forms", "fields", "submissions", "webhook_actions"},
		WebhookTopics: []string{"submission.created", "webhook.delivery"},
		DocsURL:       "/docs/integrations/ninja-forms",
	},
	{
		Provider:         ProviderFormidableForms,
		Name:             "Formidable Forms",
		Category:         "forms",
		AuthMode:         "wordpress_application_password_or_formidable_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "formidable_forms_entries_rest_backfill_scheduled_retry",
		VerificationMode: "formidable_forms_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_url", Label: "Site URL", Required: true, Help: "WordPress site URL hosting Formidable Forms"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Formidable Forms form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference for a WordPress application password or Formidable API key with entries permissions"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_name", Label: "Form name", Help: "Optional display name for imported Formidable Forms entries"},
			{Key: "page_size", Label: "Page size", Help: "Entries page size, capped at 200 by this runtime"},
			{Key: "plugin_namespace", Label: "Plugin namespace", Help: "Optional custom REST namespace; defaults to frm/v2"},
			{Key: "search", Label: "Search text", Help: "Optional full-text search across Formidable entry fields"},
			{Key: "order_by", Label: "Sort field", Help: "Optional Formidable sort key: id, created_at, updated_at, or form_id"},
			{Key: "order", Label: "Sort direction", Help: "Optional sort direction: ASC or DESC"},
			{Key: "email_field_id", Label: "Email field ID", Help: "Optional Formidable field ID used for email identity mapping"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional Formidable field key used for email identity mapping"},
			{Key: "first_name_field_id", Label: "First name field ID", Help: "Optional Formidable field ID used for first-name mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional Formidable field key used for first-name mapping"},
			{Key: "last_name_field_id", Label: "Last name field ID", Help: "Optional Formidable field ID used for last-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional Formidable field key used for last-name mapping"},
			{Key: "full_name_field_id", Label: "Full name field ID", Help: "Optional Formidable field ID used for full-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional Formidable field key used for full-name mapping"},
			{Key: "phone_field_id", Label: "Phone field ID", Help: "Optional Formidable field ID used for phone mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional Formidable field key used for phone mapping"},
			{Key: "company_field_id", Label: "Company field ID", Help: "Optional Formidable field ID used for company mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional Formidable field key used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Formidable Forms leads"},
		},
		Scopes:      []string{"forms.read", "fields.read", "entries.read"},
		SyncObjects: []string{"forms", "fields", "entries"},
		DocsURL:     "/docs/integrations/formidable-forms",
	},
	managedLeadProviderSpec(
		ProviderInteract,
		"Interact",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Interact account identifier"},
			{Key: "quiz_id", Label: "Quiz ID", Required: true, Help: "Interact quiz, assessment, or giveaway identifier"},
		},
		[]ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign grouping identifier"},
		},
		[]string{"quizzes.read", "leads.read", "answers.read"},
		[]string{"quizzes", "questions", "answers", "leads", "outcomes"},
		[]string{"lead.created", "quiz.completed"},
	),
	{
		Provider:         ProviderOutgrow,
		Name:             "Outgrow",
		Category:         "forms",
		AuthMode:         "webhook_basic_or_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "outgrow_webhook_ingest",
		VerificationMode: "outgrow_basic_or_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Outgrow account identifier used to route incoming webhook deliveries"},
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Outgrow calculator, quiz, poll, or campaign identifier used to route incoming webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Moosewave route token or Basic auth credentials configured on the Outgrow webhook"},
		},
		OptionalSettings: []ProviderField{
			{Key: "calculator_id", Label: "Calculator ID", Help: "Optional calculator identifier when separate from campaign"},
			{Key: "quiz_id", Label: "Quiz ID", Help: "Optional quiz identifier when separate from campaign"},
			{Key: "experience_type", Label: "Experience type", Help: "Optional Outgrow experience type for operator evidence"},
			{Key: "campaign_name", Label: "Campaign name", Help: "Optional campaign display name when webhook payloads omit content metadata"},
			{Key: "calculator_name", Label: "Calculator name", Help: "Optional calculator display name when webhook payloads omit content metadata"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Outgrow leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Outgrow leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional webhook lead field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional webhook lead field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional webhook lead field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional webhook lead field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional webhook lead field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional webhook lead field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "basic_auth.verify", "route_token.verify"},
		SyncObjects:   []string{"campaigns", "calculators", "quizzes", "questions", "answers", "leads", "visits", "webhook_destinations"},
		WebhookTopics: []string{"lead.created", "visit.created", "result.calculated", "webhook.delivery"},
		DocsURL:       "/docs/integrations/outgrow",
	},
	{
		Provider:         ProviderRiddle,
		Name:             "Riddle",
		Category:         "forms",
		AuthMode:         "webhook_signature_or_route_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "riddle_webhook_ingest",
		VerificationMode: "riddle_signature_or_route_token_webhook_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Riddle account identifier used to route incoming webhook deliveries"},
			{Key: "quiz_id", Label: "Quiz ID", Required: true, Help: "Riddle quiz, poll, or assessment identifier used to route incoming webhook deliveries"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Riddle signature key or Moosewave route token configured on the webhook URL"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional campaign grouping identifier when Riddle deliveries include one"},
			{Key: "riddle_id", Label: "Riddle ID", Help: "Optional alias for quiz_id when operator evidence uses Riddle terminology"},
			{Key: "riddle_name", Label: "Riddle name", Help: "Optional Riddle display name when webhook payloads omit quiz metadata"},
			{Key: "quiz_name", Label: "Quiz name", Help: "Optional quiz display name when webhook payloads omit quiz metadata"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Riddle leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Riddle leads"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional Riddle lead field key to use for email identity"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional Riddle lead field key to use for first name"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional Riddle lead field key to use for last name"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional Riddle lead field key to use for full name"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional Riddle lead field key to use for phone"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional Riddle lead field key to use for company"},
			{Key: "submitted_at_field_key", Label: "Submitted-at field key", Help: "Optional webhook field key to use for submission time"},
		},
		Scopes:        []string{"webhooks.configure", "webhook_signature.verify", "route_token.verify"},
		SyncObjects:   []string{"riddles", "lead_forms", "questions", "answers", "results", "leads", "webhook_destinations"},
		WebhookTopics: []string{"lead.created", "riddle.completed", "webhook.delivery"},
		DocsURL:       "/docs/integrations/riddle",
	},
	managedLeadProviderSpec(
		ProviderQualtricsForms,
		"Qualtrics Forms",
		"oauth_ref",
		[]ProviderField{
			{Key: "brand_id", Label: "Brand ID", Required: true, Help: "Qualtrics brand or datacenter tenant identifier"},
			{Key: "survey_id", Label: "Survey ID", Required: true, Help: "Qualtrics survey or form identifier"},
		},
		[]ProviderField{
			{Key: "directory_id", Label: "Directory ID", Help: "Optional XM Directory identifier for contacts"},
		},
		[]string{"surveys.read", "responses.read", "directories.read"},
		[]string{"surveys", "questions", "responses", "directories", "contacts"},
		[]string{"response.created", "response.updated"},
	),
	{
		Provider:         ProviderFeathery,
		Name:             "Feathery",
		Category:         "forms",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "feathery_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "feathery_submissions_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Feathery form identifier from the Submissions API form_id parameter"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Feathery API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional Feathery workspace identifier for operator evidence"},
			{Key: "environment", Label: "Environment", Help: "Optional Feathery environment such as production or sandbox"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional regional Feathery API base URL; defaults to https://api.feathery.io"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported form leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API page_size, capped at Feathery's documented maximum of 1000"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name applied to imported submissions"},
			{Key: "start_time", Label: "Start time", Help: "Optional lower-bound update timestamp for Feathery submissions"},
			{Key: "end_time", Label: "End time", Help: "Optional upper-bound update timestamp for Feathery submissions"},
			{Key: "created_after", Label: "Created after", Help: "Optional lower-bound creation timestamp"},
			{Key: "created_before", Label: "Created before", Help: "Optional upper-bound creation timestamp"},
			{Key: "completed", Label: "Completed filter", Help: "Optional completed-state filter for submissions"},
			{Key: "fields", Label: "Fields", Help: "Optional Feathery field projection"},
			{Key: "sort", Label: "Sort", Help: "Optional Feathery sort expression"},
			{Key: "email_field_id", Label: "Email field ID", Help: "Optional Feathery field ID used for email identity mapping"},
			{Key: "first_name_field_id", Label: "First name field ID", Help: "Optional Feathery field ID used for first-name mapping"},
			{Key: "last_name_field_id", Label: "Last name field ID", Help: "Optional Feathery field ID used for last-name mapping"},
			{Key: "full_name_field_id", Label: "Full name field ID", Help: "Optional Feathery field ID used for full-name mapping"},
			{Key: "phone_field_id", Label: "Phone field ID", Help: "Optional Feathery field ID used for phone mapping"},
			{Key: "company_field_id", Label: "Company field ID", Help: "Optional Feathery field ID used for company mapping"},
		},
		Scopes:      []string{"forms:read", "submissions:read"},
		SyncObjects: []string{"forms", "fields", "submissions"},
		DocsURL:     "/docs/integrations/feathery",
	},
	{
		Provider:         ProviderFormaloo,
		Name:             "Formaloo",
		Category:         "forms",
		AuthMode:         "api_key_secret_jwt_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "formaloo_rows_rest_backfill_scheduled_retry",
		VerificationMode: "formaloo_rows_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form slug or ID", Required: true, Help: "Formaloo form slug or identifier used with the rows endpoint"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Formaloo x-api-key plus API secret or a preissued authorization token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional Formaloo workspace header value"},
			{Key: "form_slug", Label: "Form slug", Help: "Optional explicit Formaloo form slug; overrides form_id at runtime"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name applied to imported rows"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Formaloo API base URL; defaults to https://api.formaloo.me"},
			{Key: "page_size", Label: "Page size", Help: "Rows page_size value, capped at 1000 for this runtime"},
			{Key: "created_at_gte", Label: "Created after", Help: "Optional created_at lower-bound filter"},
			{Key: "updated_at_gte", Label: "Updated after", Help: "Optional updated_at lower-bound filter"},
			{Key: "submit_time_gte", Label: "Submitted after", Help: "Optional submit_time lower-bound filter"},
			{Key: "submit_number", Label: "Submit number", Help: "Optional Formaloo submit_number filter"},
			{Key: "tracking_code", Label: "Tracking code", Help: "Optional Formaloo tracking_code filter"},
			{Key: "tags", Label: "Tags", Help: "Optional Formaloo row tags filter"},
			{Key: "search", Label: "Search", Help: "Optional Formaloo rows search filter"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional row data key used for email identity mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional row data key used for first-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional row data key used for last-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional row data key used for full-name mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional row data key used for phone mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional row data key used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Formaloo leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Formaloo leads"},
		},
		Scopes:      []string{"forms.read", "rows.read"},
		SyncObjects: []string{"forms", "rows"},
		DocsURL:     "/docs/integrations/formaloo",
	},
	{
		Provider:         Provider123FormBuilder,
		Name:             "123FormBuilder",
		Category:         "forms",
		AuthMode:         "jwt_query_ref_or_login_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "123formbuilder_submissions_rest_backfill_scheduled_retry",
		VerificationMode: "123formbuilder_submissions_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Required: true, Help: "123FormBuilder form identifier used with the REST API v2 submissions endpoint"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing a 123FormBuilder JWT or token-exchange login payload"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional 123FormBuilder account identifier for operator evidence"},
			{Key: "region", Label: "API region", Help: "Optional API region evidence such as us or eu; api_base_url controls the runtime endpoint"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional regional REST API v2 base URL; defaults to https://api.123formbuilder.com/v2"},
			{Key: "form_name", Label: "Form name", Help: "Optional display name applied to imported submissions"},
			{Key: "page_size", Label: "Page size", Help: "Submissions API per_page value, capped at 123FormBuilder's documented maximum of 1000"},
			{Key: "start_date", Label: "Start date", Help: "Optional submissions lower-bound date passed to start_date"},
			{Key: "start_submission_id", Label: "Start submission ID", Help: "Optional initial 123FormBuilder submission ID checkpoint for operator evidence"},
			{Key: "include_recipients", Label: "Include recipients", Help: "Optional include_recipients query flag for provider recipient metadata"},
			{Key: "email_field_key", Label: "Email field key", Help: "Optional 123FormBuilder content field key used for email identity mapping"},
			{Key: "first_name_field_key", Label: "First name field key", Help: "Optional content field key used for first-name mapping"},
			{Key: "last_name_field_key", Label: "Last name field key", Help: "Optional content field key used for last-name mapping"},
			{Key: "full_name_field_key", Label: "Full name field key", Help: "Optional content field key used for full-name mapping"},
			{Key: "phone_field_key", Label: "Phone field key", Help: "Optional content field key used for phone mapping"},
			{Key: "company_field_key", Label: "Company field key", Help: "Optional content field key used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported 123FormBuilder leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported leads"},
		},
		Scopes:      []string{"forms.read", "submissions.read"},
		SyncObjects: []string{"forms", "submissions"},
		DocsURL:     "/docs/integrations/123formbuilder",
	},
	{
		Provider:         ProviderGravityForms,
		Name:             "Gravity Forms",
		Category:         "forms",
		AuthMode:         "wordpress_app_password_or_gravity_forms_basic_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "gravity_forms_entries_rest_backfill_scheduled_retry",
		VerificationMode: "gravity_forms_entries_rest_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_url", Label: "Site URL", Required: true, Help: "WordPress site URL hosting Gravity Forms"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Gravity Forms form identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference for WordPress application password or REST credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_name", Label: "Form name", Help: "Optional display name for imported Gravity Forms entries"},
			{Key: "page_size", Label: "Page size", Help: "Entries page size, capped at 200 for this runtime"},
			{Key: "status", Label: "Entry status", Help: "Optional Gravity Forms entry status filter"},
			{Key: "email_field_id", Label: "Email field ID", Help: "Optional Gravity Forms input ID used for email identity mapping"},
			{Key: "first_name_field_id", Label: "First name field ID", Help: "Optional Gravity Forms input ID used for first-name mapping"},
			{Key: "last_name_field_id", Label: "Last name field ID", Help: "Optional Gravity Forms input ID used for last-name mapping"},
			{Key: "full_name_field_id", Label: "Full name field ID", Help: "Optional Gravity Forms input ID used for full-name mapping"},
			{Key: "phone_field_id", Label: "Phone field ID", Help: "Optional Gravity Forms input ID used for phone mapping"},
			{Key: "company_field_id", Label: "Company field ID", Help: "Optional Gravity Forms input ID used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Gravity Forms leads"},
		},
		Scopes:      []string{"forms.read", "entries.read"},
		SyncObjects: []string{"forms", "entries"},
		DocsURL:     "/docs/integrations/gravity-forms",
	},
	{
		Provider:         ProviderWPForms,
		Name:             "WPForms",
		Category:         "forms",
		AuthMode:         "wordpress_application_password_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "wpforms_abilities_api_entry_search_scheduled_retry",
		VerificationMode: "wpforms_pro_abilities_api_live_certification_pending",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_url", Label: "Site URL", Required: true, Help: "WordPress site URL hosting WPForms"},
			{Key: "form_id", Label: "Form ID", Required: true, Help: "Numeric WPForms form ID"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference for a WordPress application password with WPForms entry permissions"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_name", Label: "Form name", Help: "Optional display name for imported WPForms entries"},
			{Key: "page_size", Label: "Page size", Help: "Entries page size, capped at 100 by the WPForms Abilities API"},
			{Key: "status", Label: "Entry status", Help: "Optional WPForms status filter: partial, abandoned, spam, or trash; empty returns completed entries"},
			{Key: "type", Label: "Entry type", Help: "Optional WPForms type filter: read, unread, or starred"},
			{Key: "search", Label: "Search text", Help: "Optional full-text search across entry fields"},
			{Key: "field_id", Label: "Search field ID", Help: "Optional field ID for exact field_value filtering"},
			{Key: "field_value", Label: "Search field value", Help: "Optional exact value for the configured field_id"},
			{Key: "date_from", Label: "Date from", Help: "Optional YYYY-MM-DD lower bound for WPForms search"},
			{Key: "date_to", Label: "Date to", Help: "Optional YYYY-MM-DD upper bound for WPForms search"},
			{Key: "email_field_id", Label: "Email field ID", Help: "Optional WPForms field ID used for email identity mapping"},
			{Key: "first_name_field_id", Label: "First name field ID", Help: "Optional WPForms field ID used for first-name mapping"},
			{Key: "last_name_field_id", Label: "Last name field ID", Help: "Optional WPForms field ID used for last-name mapping"},
			{Key: "full_name_field_id", Label: "Full name field ID", Help: "Optional WPForms field ID used for full-name mapping"},
			{Key: "phone_field_id", Label: "Phone field ID", Help: "Optional WPForms field ID used for phone mapping"},
			{Key: "company_field_id", Label: "Company field ID", Help: "Optional WPForms field ID used for company mapping"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported WPForms leads"},
		},
		Scopes:      []string{"view_forms", "view_entries_form_single"},
		SyncObjects: []string{"forms", "entries"},
		DocsURL:     "/docs/integrations/wpforms",
	},
	{
		Provider:      ProviderWordPress,
		Name:          "WordPress",
		Category:      "cms",
		AuthMode:      "application_password_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_url", Label: "Site URL", Required: true, Help: "WordPress site URL"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference for WordPress application password or plugin token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "list_id", Label: "Default list ID", Help: "Optional list or newsletter audience identifier"},
		},
		Scopes:        []string{"users.read", "posts.read"},
		SyncObjects:   []string{"subscribers", "users", "forms"},
		WebhookTopics: []string{"subscriber.created", "subscriber.updated", "form.submitted"},
		DocsURL:       "/docs/integrations/wordpress",
	},
	{
		Provider:         ProviderWebflow,
		Name:             "Webflow",
		Category:         "cms",
		AuthMode:         "oauth_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "webflow_forms_webhook_backfill",
		VerificationMode: "webflow_hmac_sha256",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Webflow site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Webflow OAuth token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Help: "Optional Webflow form identifier for form-scoped submission pulls"},
			{Key: "form_element_id", Label: "Form element ID", Help: "Optional centralized Webflow form element ID for site-level submission filtering"},
			{Key: "form_name", Label: "Form name", Help: "Optional Webflow form name filter"},
			{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported Webflow leads"},
			{Key: "list_id", Label: "Default list ID", Help: "Optional Moosewave list ID for imported Webflow leads"},
			{Key: "webhook_secret_ref", Label: "Webhook signing-secret reference", Secret: true, Help: "Vault reference containing the Webflow site token secret or OAuth client secret used for x-webflow-signature validation"},
			{Key: "page_size", Label: "Page size", Help: "Form submissions API page size, capped at Webflow's maximum of 100"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override for private/proxied Webflow API hosts"},
		},
		Scopes:        []string{"forms:read", "sites:read", "sites:write"},
		SyncObjects:   []string{"forms", "submissions"},
		WebhookTopics: []string{"form_submission"},
		DocsURL:       "/docs/integrations/webflow",
	},
	{
		Provider:         ProviderWix,
		Name:             "Wix",
		Category:         "cms",
		AuthMode:         "oauth_app_instance_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        "wix_forms_contacts_jwt_webhook_backfill",
		VerificationMode: "wix_rs256_jwt_or_shared_secret",
		Capabilities:     []string{"profiles", "events", "lists", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Wix site identifier"},
			{Key: "instance_id", Label: "App instance ID", Required: true, Help: "Wix app instance ID used with app credentials to mint access tokens and route webhooks"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Wix OAuth token or app credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Help: "Optional Wix form identifier"},
			{Key: "namespace", Label: "Submission namespace", Help: "Optional Wix form-submission namespace; defaults to wix.form_app.form"},
			{Key: "webhook_public_key_ref", Label: "Webhook public-key reference", Help: "Vault reference containing the Wix webhook JWT public key"},
			{Key: "webhook_secret_ref", Label: "Webhook shared-secret reference", Help: "Optional shared secret for JSON bridge/test webhook payloads"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Wix API base URL override for tests or regional gateways"},
			{Key: "token_url", Label: "Token URL", Help: "Optional Wix OAuth token URL override"},
			{Key: "page_size", Label: "Page size", Help: "Wix query page size, capped at 100"},
		},
		Scopes:        []string{"contacts.read", "forms.read", "forms.submissions.read", "manage-your-app", "webhooks.read"},
		SyncObjects:   []string{"contacts", "forms", "submissions"},
		WebhookTopics: []string{"wix.forms.v4.submission.created", "wix.forms.v4.submission.updated", "wix.contacts.v4.contact.created", "wix.contacts.v4.contact.updated", "wix.contacts.v4.contact.deleted", "wix.app.v1.instance.installed", "wix.app.v1.instance.removed"},
		DocsURL:       "/docs/integrations/wix",
	},
	{
		Provider:      ProviderSquarespace,
		Name:          "Squarespace",
		Category:      "cms",
		AuthMode:      "webhook_bridge_ref",
		Managed:       true,
		RuntimeStatus: "delegated",
		Capabilities:  []string{"profiles", "events", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Squarespace site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference for the receiving webhook secret or bridge token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "form_id", Label: "Form ID", Help: "Optional Squarespace form identifier when supplied by the webhook payload"},
			{Key: "bridge_provider", Label: "Bridge provider", Help: "Optional bridge such as Zapier, Make, n8n, or direct inbound webhook"},
		},
		Scopes:        []string{"webhook.ingest", "bridge.configure"},
		SyncObjects:   []string{"webhook_submissions", "profiles", "events"},
		WebhookTopics: []string{"form.submitted.forwarded"},
		DocsURL:       "/docs/integrations/squarespace",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := append([]ProviderSpec(nil), providerSpecs...)
	for i := range out {
		out[i] = withRequiredLists(withLeadSpecDefaults(out[i]))
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func ProviderSpecByKey(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range providerSpecs {
		if spec.Provider == key {
			return withLeadSpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

const leadSyncModelIngest = "postwave_submission_ingest"

var leadCanonicalSyncObjects = []string{"submissions", "profiles", "events"}

func withLeadSpecDefaults(spec ProviderSpec) ProviderSpec {
	if spec.Provider == ProviderSquarespace {
		spec.Managed = false
		spec.RuntimeStatus = "delegated"
		spec.SyncModel = "bridge_only"
		spec.VerificationMode = "bridge_ingest_token"
	}
	if spec.SyncModel == "" {
		spec.SyncModel = leadSyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = leadVerificationMode(spec.Provider)
	}
	if spec.SyncModel == leadSyncModelIngest {
		spec.Scopes = nil
		spec.SyncObjects = append([]string(nil), leadCanonicalSyncObjects...)
		spec.WebhookTopics = nil
		spec.VerificationMode = "postwave_ingest_token"
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
	}
	return spec
}

func withoutProviderField(fields []ProviderField, key string) []ProviderField {
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if strings.EqualFold(strings.TrimSpace(field.Key), key) {
			continue
		}
		out = append(out, field)
	}
	return out
}

func leadVerificationMode(provider string) string {
	switch provider {
	case ProviderTypeform:
		return "typeform_hmac_sha256"
	case ProviderWix:
		return "wix_rs256_jwt_or_shared_secret"
	case ProviderJotform:
		return "postwave_shared_secret"
	case ProviderWebflow:
		return "webflow_hmac_sha256"
	case ProviderFillout:
		return "postwave_url_token"
	case ProviderSquarespace:
		return "bridge_ingest_token"
	default:
		return "postwave_ingest_token"
	}
}

func normalizeIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("provider is required")
	}
	spec, ok := ProviderSpecByKey(in.Provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported lead provider %q", in.Provider)
	}
	if !spec.Managed {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%s is bridge-only; use inbound webhooks or bridge recipes instead of native lead integrations", spec.Name)
	}
	settings := copySettings(in.Settings)
	delete(settings, "provider_cleanup")
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	credentialsRef := firstString(in.CredentialsRef, settingString(settings, "credentials_ref"), settingString(settings, "credential_ref"))
	if credentialsRef != "" {
		if looksLikeRawCredentialRef(credentialsRef) {
			return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%w: credentials_ref looks like raw credential material", errRawCredentialSetting)
		}
		settings["credentials_ref"] = credentialsRef
		delete(settings, "credential_ref")
	}
	if spec.SyncModel == leadSyncModelIngest || spec.Provider == ProviderSurveyMonkey || spec.Provider == ProviderUnbounce || spec.Provider == ProviderLeadpages || spec.Provider == Provider123FormBuilder || spec.Provider == ProviderInstapage || spec.Provider == ProviderCarrd || spec.Provider == ProviderOptinMonster || spec.Provider == ProviderPrivy || spec.Provider == ProviderConvertFlow || spec.Provider == ProviderSleeknote || spec.Provider == ProviderWisepops || spec.Provider == ProviderPoptin || spec.Provider == ProviderHelloBar || spec.Provider == ProviderLandingi || spec.Provider == ProviderKickoffLabs || spec.Provider == ProviderNinjaForms || spec.Provider == ProviderOutgrow || spec.Provider == ProviderShortStack || spec.Provider == ProviderRiddle || spec.Provider == ProviderPaperform || spec.Provider == ProviderFormstack || spec.Provider == ProviderFormsite || spec.Provider == ProviderCognitoForms || spec.Provider == ProviderGravityForms || spec.Provider == ProviderWPForms || spec.Provider == ProviderFormidableForms || spec.Provider == ProviderFeathery || spec.Provider == ProviderFormaloo || spec.Provider == ProviderGoogleForms || spec.Provider == ProviderTally {
		stripUnverifiedWebhookCredentialRefs(settings)
	}
	for _, field := range spec.RequiredSettings {
		switch field.Key {
		case "credentials_ref":
			if credentialsRef == "" {
				return IntegrationInput{}, ProviderSpec{}, errors.New("credentials_ref is required")
			}
		default:
			if settingString(settings, field.Key) == "" {
				return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%s is required", field.Key)
			}
		}
	}
	if err := integration_egress.ValidateSettings(integration_egress.FamilyLeads, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "form_id"),
			settingString(settings, "survey_id"),
			settingString(settings, "site_id"),
			settingString(settings, "site_url"),
			settingString(settings, "page_id"),
			settingString(settings, "account_id"),
			settingString(settings, "client_id"),
			settingString(settings, "workspace_id"),
			settingString(settings, "ad_account_id"),
			settingString(settings, "customer_id"),
			settingString(settings, "advertiser_id"),
			settingString(settings, "organization_id"),
			settingString(settings, "campaign_id"),
			settingString(settings, "popup_id"),
			settingString(settings, "quiz_id"),
			settingString(settings, "brand_id"),
			settingString(settings, "lead_form_asset_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["setup_surface"] = "lead_integrations"
	settings["egress_policy_version"] = "v1"
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(in.RunMode))
	if in.RunMode == "" {
		in.RunMode = "manual"
	}
	in.Cursor = strings.TrimSpace(in.Cursor)
	for i := range in.Submissions {
		in.Submissions[i].SourceID = strings.TrimSpace(in.Submissions[i].SourceID)
		in.Submissions[i].Email = strings.ToLower(strings.TrimSpace(in.Submissions[i].Email))
		in.Submissions[i].FirstName = strings.TrimSpace(in.Submissions[i].FirstName)
		in.Submissions[i].LastName = strings.TrimSpace(in.Submissions[i].LastName)
		in.Submissions[i].FullName = strings.TrimSpace(in.Submissions[i].FullName)
		in.Submissions[i].Phone = strings.TrimSpace(in.Submissions[i].Phone)
		in.Submissions[i].Company = strings.TrimSpace(in.Submissions[i].Company)
		in.Submissions[i].FormID = strings.TrimSpace(in.Submissions[i].FormID)
		in.Submissions[i].FormName = strings.TrimSpace(in.Submissions[i].FormName)
		in.Submissions[i].EventName = strings.TrimSpace(in.Submissions[i].EventName)
	}
	return in
}

func copySettings(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+4)
	for k, v := range in {
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

func rawCredentialSetting(settings map[string]any) string {
	for _, key := range []string{
		"access_token",
		"api_key",
		"api_secret",
		"bearer_token",
		"client_secret",
		"consumer_secret",
		"developer_token",
		"password",
		"private_app_token",
		"refresh_token",
		"secret",
		"token",
		"webhook_secret",
	} {
		if _, ok := settings[key]; ok {
			return key
		}
	}
	return ""
}

func stripUnverifiedWebhookCredentialRefs(settings map[string]any) {
	for _, key := range []string{
		"webhook_secret_ref",
		"webhook_token_ref",
		"signing_secret_ref",
		"signature_secret_ref",
		"verification_token_ref",
	} {
		delete(settings, key)
	}
}

func looksLikeRawCredentialRef(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	rawPrefixes := []string{
		"bearer ",
		"basic ",
		"sk_live_",
		"sk_test_",
		"rk_live_",
		"pk_live_",
		"shpat_",
		"xoxb-",
		"xoxp-",
		"ya29.",
		"ghp_",
		"gho_",
		"github_pat_",
		"glpat-",
		"pat-",
	}
	for _, prefix := range rawPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if strings.HasPrefix(lower, "eyj") || strings.HasPrefix(trimmed, "eyJ") {
		return true
	}
	if strings.ContainsAny(trimmed, " \t\r\n") {
		return true
	}
	return len(trimmed) > 80 && !strings.Contains(trimmed, ":") && !strings.Contains(trimmed, "/")
}

func settingString(settings map[string]any, key string) string {
	v, ok := settings[strings.ToLower(strings.TrimSpace(key))]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func firstString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// withRequiredLists gives a spec every list LeadProviderSpec requires as an
// array (capabilities, required_settings, scopes, sync_objects). Ingest-token
// providers have no OAuth scopes and withLeadSpecDefaults clears them; a nil
// slice marshals to JSON null, which the contract does not allow.
func withRequiredLists(spec ProviderSpec) ProviderSpec {
	if spec.Capabilities == nil {
		spec.Capabilities = []string{}
	}
	if spec.RequiredSettings == nil {
		spec.RequiredSettings = []ProviderField{}
	}
	if spec.Scopes == nil {
		spec.Scopes = []string{}
	}
	if spec.SyncObjects == nil {
		spec.SyncObjects = []string{}
	}
	return spec
}
