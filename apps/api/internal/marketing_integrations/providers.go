// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

const (
	klaviyoSyncModelNativeFoundation = klaviyoNativeSyncModel
	klaviyoVerificationMode          = klaviyoNativeVerification

	mailchimpSyncModelNativeFoundation       = "mailchimp_native_provider_row_migration_source_archive_foundation"
	activeCampaignSyncModelNativeFoundation  = "activecampaign_native_provider_row_source_event_foundation"
	customerIOSyncModelNativeFoundation      = "customerio_native_provider_row_migration_foundation"
	brevoSyncModelNativeFoundation           = "brevo_native_provider_row_migration_foundation"
	convertKitSyncModelNativeFoundation      = "convertkit_native_provider_row_migration_foundation"
	substackSyncModelNativeFoundation        = "substack_native_provider_row_csv_stripe_migration_foundation"
	beehiivSyncModelNativeFoundation         = "beehiiv_native_provider_row_api_v2_migration_foundation"
	mailerLiteSyncModelNativeFoundation      = "mailerlite_native_provider_row_connect_api_migration_foundation"
	sendySyncModelNativeFoundation           = "sendy_native_provider_row_csv_export_migration_foundation"
	constantContactSyncModelNativeFoundation = "constant_contact_native_provider_row_csv_export_migration_foundation"
	aweberSyncModelNativeFoundation          = "aweber_native_provider_row_csv_export_migration_foundation"
	dripSyncModelNativeFoundation            = "drip_native_provider_row_csv_export_migration_foundation"
	campaignMonitorSyncModelNativeFoundation = "campaign_monitor_native_provider_row_csv_export_migration_foundation"
	omnisendSyncModelNativeFoundation        = "omnisend_native_provider_row_csv_export_migration_foundation"
	loopsSyncModelNativeFoundation           = "loops_native_provider_row_csv_export_migration_foundation"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

var providerSpecs = []ProviderSpec{
	{
		Provider:         ProviderKlaviyo,
		Name:             "Klaviyo",
		Category:         "marketing",
		AuthMode:         "klaviyo_private_api_key_ref_or_oauth_public_app",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        klaviyoSyncModelNativeFoundation,
		VerificationMode: klaviyoVerificationMode,
		Capabilities:     []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault or managed OAuth reference containing Klaviyo private API-key material or OAuth tokens; raw private keys and tokens are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Klaviyo account ID", Help: "Optional Klaviyo account or company identifier for operator audit"},
			{Key: "revision", Label: "Klaviyo API revision", Help: "Optional Klaviyo API revision evidence; native JSON:API pulls default to the adapter revision"},
			{Key: "profile_cursor", Label: "Profile cursor", Help: "Optional native profile page cursor used to resume provider-row backfills"},
			{Key: "source_event_cursor", Label: "Source-event cursor", Help: "Optional native changed-profile page cursor used to resume provider-row source-event polling"},
			{Key: "source_event_high_watermark", Label: "Source-event high watermark", Help: "Optional native changed-profile high-watermark used by scheduled provider-row polling"},
			{Key: "klaviyo_webhook_token", Label: "Klaviyo webhook token", Help: "Opaque token embedded in the Moosewave public Klaviyo system-webhook URL"},
			{Key: "klaviyo_webhook_secret_ref", Label: "Klaviyo webhook secret reference", Secret: true, Help: "Vault reference containing the Klaviyo webhook secret_key used for HMAC verification"},
			{Key: "klaviyo_webhook_id", Label: "Klaviyo webhook ID", Help: "Optional provider webhook ID returned by Klaviyo for operator cleanup evidence"},
			{Key: "klaviyo_webhook_topics", Label: "Klaviyo webhook topics", Help: "Provider system-webhook topic IDs used when Moosewave reconciles the Klaviyo Webhooks API subscription"},
			{Key: "klaviyo_webhook_endpoint", Label: "Klaviyo webhook endpoint", Help: "Moosewave public webhook endpoint recorded after managed Klaviyo Webhooks API reconciliation"},
			{Key: "klaviyo_webhook_managed_by_postwave", Label: "Managed Klaviyo webhook", Help: "True when Moosewave should reconcile and clean up the provider-side Klaviyo system webhook"},
			{Key: "migration_job_id", Label: "Legacy migration job ID", Help: "Optional legacy migration job retained only for old handoff cursor compatibility"},
			{Key: "source_event_job_id", Label: "Legacy source-event job ID", Help: "Optional legacy source-event monitor retained only for old handoff cursor compatibility"},
		},
		Scopes:        []string{"profiles:read", "lists:read", "segments:read", "flows:read", "campaigns:read", "templates:read", "events:read", "webhooks:read", "webhooks:write"},
		SyncObjects:   []string{"profiles", "lists", "segments", "flows", "campaigns", "templates", "profile_source_events", "system_webhook_events"},
		WebhookTopics: []string{"klaviyo.system_webhook.event", "klaviyo.system_webhook.profile"},
		DocsURL:       "/docs/integrations/klaviyo",
	},
	{
		Provider:         ProviderMailchimp,
		Name:             "Mailchimp",
		Category:         "marketing",
		AuthMode:         "mailchimp_oauth_or_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        mailchimpSyncModelNativeFoundation,
		VerificationMode: "mailchimp_credential_ref_provider_row_delegated_migration_source_archive",
		Capabilities:     []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing Mailchimp OAuth session or API-key material; raw tokens and keys are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Mailchimp account ID", Help: "Optional Mailchimp account identifier returned by OAuth or operator audit"},
			{Key: "data_center", Label: "Data center", Help: "Optional Mailchimp data-center/account server prefix such as us21 when not encoded in the credential reference"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for API-backed import/source-archive evidence while the full native data plane is built"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated migration cursor to preserve in the provider-row handoff cursor"},
		},
		Scopes:        []string{"audiences:read", "campaigns:read", "templates:read", "reports:read", "automations:read", "ecommerce:read"},
		SyncObjects:   []string{"profiles", "lists", "segments", "groups", "automations", "campaigns", "templates", "reports", "forms", "landing_pages", "ecommerce_stores", "source_archive_rebuild_tasks"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/mailchimp",
	},
	{
		Provider:         ProviderActiveCampaign,
		Name:             "ActiveCampaign",
		Category:         "marketing",
		AuthMode:         "activecampaign_api_token_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        activeCampaignSyncModelNativeFoundation,
		VerificationMode: "activecampaign_credential_ref_provider_row_delegated_api_v3_source_events",
		Capabilities:     []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing the ActiveCampaign API token; raw API tokens are rejected from settings"},
			{Key: "api_url", Label: "Account API URL", Required: true, Help: "ActiveCampaign account API URL, for example https://example.api-us1.com/api/3"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account identifier", Help: "Optional normalized account identifier for operator audit"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for API-backed import evidence"},
			{Key: "source_event_job_id", Label: "Source-event job ID", Help: "Temporary source-event monitor used for changed-contact evidence"},
			{Key: "source_event_cursor", Label: "Source-event cursor", Help: "Optional delegated monitor cursor to preserve in the provider-row handoff cursor"},
			{Key: "source_event_high_watermark", Label: "Source-event high watermark", Help: "Optional delegated monitor high-watermark evidence to preserve in the provider-row handoff cursor"},
			{Key: "poll_interval_seconds", Label: "Polling interval", Help: "Optional changed-contact polling interval for the delegated monitor"},
		},
		Scopes:        []string{"contacts:read", "lists:read", "tags:read", "automations:read", "campaigns:read", "forms:read", "deals:read"},
		SyncObjects:   []string{"profiles", "lists", "segments", "tags", "automation_rebuild_tasks", "campaigns", "forms", "deals", "pipelines", "custom_objects", "sms_campaigns", "contact_source_events"},
		WebhookTopics: []string{"activecampaign.source_event.contact_changed"},
		DocsURL:       "/docs/integrations/activecampaign",
	},
	{
		Provider:         ProviderCustomerIO,
		Name:             "Customer.io",
		Category:         "marketing",
		AuthMode:         "customerio_app_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        customerIOSyncModelNativeFoundation,
		VerificationMode: "customerio_credential_ref_provider_row_delegated_app_api_migration",
		Capabilities:     []string{"profiles", "segments"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing Customer.io App API key material; raw App API keys are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "region", Label: "Region", Help: "Customer.io App API region, us or eu; the delegated migration is immutably bound to it"},
			{Key: "workspace_id", Label: "Workspace ID", Help: "Numeric /v1/workspaces identity; required by the delegated migration when the credential exposes multiple workspaces"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Bound migration lineage used for full immutable-cio_id snapshots and cutover evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated migration cursor to preserve in the provider-row handoff cursor"},
		},
		Scopes:        []string{"workspaces:read", "customers:read", "segments:read", "campaigns:read", "broadcasts:read", "newsletters:read", "transactional:read", "design_studio:read", "subscription_preferences:read", "esp_suppressions:read", "optouts:read", "object_types:read"},
		SyncObjects:   []string{"email_addressable_profiles", "frozen_segment_memberships", "subscription_topics", "subscription_channels", "design_studio_email_templates", "sent_email_newsletter_archive", "workflow_rebuild_evidence", "transactional_message_evidence", "esp_suppressions", "channel_optouts", "object_type_metadata", "migration_gap_checklists"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/customerio",
	},
	{
		Provider:         ProviderBrevo,
		Name:             "Brevo",
		Category:         "marketing",
		AuthMode:         "brevo_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        brevoSyncModelNativeFoundation,
		VerificationMode: "brevo_credential_ref_provider_row_delegated_contacts_campaigns_migration",
		Capabilities:     []string{"profiles", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing Brevo API-key material; raw API keys are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional Brevo workspace/account identifier for operator audit"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for contacts, lists, segments, automations, and campaign import evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated migration cursor to preserve in the provider-row handoff cursor"},
		},
		Scopes:        []string{"contacts:read", "lists:read", "segments:read", "automations:read", "campaigns:read"},
		SyncObjects:   []string{"profiles", "lists", "segments", "automations", "campaigns", "reports"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/brevo",
	},
	{
		Provider:         ProviderConvertKit,
		Name:             "ConvertKit",
		Category:         "marketing",
		AuthMode:         "convertkit_oauth_or_api_secret_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        convertKitSyncModelNativeFoundation,
		VerificationMode: "convertkit_credential_ref_provider_row_delegated_subscriber_broadcast_migration",
		Capabilities:     []string{"profiles", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing ConvertKit/Kit OAuth or API-secret material; raw tokens and secrets are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional ConvertKit/Kit account identifier for operator audit"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for subscriber, tag, segment, sequence, and broadcast import evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated migration cursor to preserve in the provider-row handoff cursor"},
			{Key: "stripe_account_id", Label: "Stripe account ID", Help: "Optional Stripe Connect account used by the delegated migration path for paid-subscription evidence"},
		},
		Scopes:        []string{"subscribers:read", "tags:read", "segments:read", "sequences:read", "broadcasts:read", "forms:read"},
		SyncObjects:   []string{"subscribers", "tags", "segments", "sequences", "broadcasts", "forms", "landing_pages", "paid_subscriptions_stripe_connect"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/convertkit",
	},
	{
		Provider:         ProviderSubstack,
		Name:             "Substack",
		Category:         "marketing",
		AuthMode:         "substack_export_bundle_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        substackSyncModelNativeFoundation,
		VerificationMode: "substack_credential_ref_provider_row_delegated_export_migration",
		Capabilities:     []string{"profiles", "lists", "campaigns", "reports"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Export bundle reference", Required: true, Secret: true, Help: "Vault reference containing Substack export bundle metadata; raw file paths and cookies are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "publication_url", Label: "Publication URL", Help: "Optional Substack publication URL for operator audit"},
			{Key: "publication_id", Label: "Publication ID", Help: "Optional publication identifier when supplied by the export workflow"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for subscribers, post archive, aggregate stats, and parity evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated export migration cursor to preserve in the provider-row handoff cursor"},
			{Key: "archive_stats_ref", Label: "Archive stats reference", Help: "Optional referenced archive stats overlay; raw local file paths stay out of settings"},
		},
		Scopes:        []string{"subscribers:read", "posts:read", "stats:read"},
		SyncObjects:   []string{"subscribers", "lists", "posts", "campaign_archive", "reports", "migration_parity_evidence"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/substack",
	},
	{
		Provider:         ProviderBeehiiv,
		Name:             "beehiiv",
		Category:         "marketing",
		AuthMode:         "beehiiv_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        beehiivSyncModelNativeFoundation,
		VerificationMode: "beehiiv_credential_ref_provider_row_delegated_api_v2_migration",
		Capabilities:     []string{"profiles", "lists", "segments", "campaigns", "reports"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing beehiiv API-key material; raw API keys are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "publication_id", Label: "Publication ID", Help: "Optional only when the API key exposes exactly one publication; multi-publication workspaces require an explicit publication ID because no chooser is implemented"},
			{Key: "account_id", Label: "Account ID", Help: "Compatibility publication selector used by delegated migration clients; prefer publication_id for explicit publication binding"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary publication-scoped migration job used for subscribers, segment snapshots, automation rebuild evidence, sent-post archive, reports, and source-archive review evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated API migration cursor to preserve in the provider-row handoff cursor"},
		},
		Scopes:        []string{"identify:read", "publications:read", "subscriptions:read", "newsletter_lists:read", "segments:read", "condition_sets:read", "automations:read", "posts:read", "custom_fields:read"},
		SyncObjects:   []string{"subscribers", "newsletter_lists", "newsletter_list_subscription_history", "segments", "segment_membership_snapshots", "condition_set_definitions", "custom_field_definitions", "automation_rebuild_tasks", "automation_email_inventory", "automation_journey_history", "campaign_archive", "reports", "premium_membership_metadata", "source_archive_rebuild_tasks"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/beehiiv",
	},
	{
		Provider:         ProviderMailerLite,
		Name:             "MailerLite",
		Category:         "marketing",
		AuthMode:         "mailerlite_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        mailerLiteSyncModelNativeFoundation,
		VerificationMode: "mailerlite_credential_ref_provider_row_delegated_connect_api_migration",
		Capabilities:     []string{"profiles", "lists", "segments", "automation_triggers", "campaigns", "reports"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Secret: true, Help: "Vault reference containing MailerLite API-key material; raw API keys are rejected from settings"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional MailerLite workspace identifier for operator audit"},
			{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for subscribers, groups, segments, automations, campaigns, and source-archive evidence"},
			{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated API migration cursor to preserve in the provider-row handoff cursor"},
		},
		Scopes:        []string{"subscribers:read", "groups:read", "segments:read", "automations:read", "campaigns:read"},
		SyncObjects:   []string{"subscribers", "groups", "segments", "automations", "campaigns", "reports", "source_archive_rebuild_tasks"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/mailerlite",
	},
	{
		Provider:         ProviderSendy,
		Name:             "Sendy",
		Category:         "marketing",
		AuthMode:         "sendy_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        sendySyncModelNativeFoundation,
		VerificationMode: "sendy_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Sendy CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Sendy", "list or brand"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"subscribers", "lists", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/sendy",
	},
	{
		Provider:         ProviderConstantContact,
		Name:             "Constant Contact",
		Category:         "marketing",
		AuthMode:         "constant_contact_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        constantContactSyncModelNativeFoundation,
		VerificationMode: "constant_contact_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Constant Contact CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Constant Contact", "account or list"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"contacts", "lists", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/constant-contact",
	},
	{
		Provider:         ProviderAWeber,
		Name:             "AWeber",
		Category:         "marketing",
		AuthMode:         "aweber_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        aweberSyncModelNativeFoundation,
		VerificationMode: "aweber_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing AWeber CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("AWeber", "account or list"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"subscribers", "lists", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/aweber",
	},
	{
		Provider:         ProviderDrip,
		Name:             "Drip",
		Category:         "marketing",
		AuthMode:         "drip_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        dripSyncModelNativeFoundation,
		VerificationMode: "drip_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Drip CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Drip", "account or export"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"people", "tags", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/drip",
	},
	{
		Provider:         ProviderCampaignMonitor,
		Name:             "Campaign Monitor",
		Category:         "marketing",
		AuthMode:         "campaign_monitor_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        campaignMonitorSyncModelNativeFoundation,
		VerificationMode: "campaign_monitor_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Campaign Monitor CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Campaign Monitor", "client or list"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"subscribers", "lists", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/campaign-monitor",
	},
	{
		Provider:         ProviderOmnisend,
		Name:             "Omnisend",
		Category:         "marketing",
		AuthMode:         "omnisend_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        omnisendSyncModelNativeFoundation,
		VerificationMode: "omnisend_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists", "segments"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Omnisend CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Omnisend", "store or segment"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"contacts", "segments", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/omnisend",
	},
	{
		Provider:         ProviderLoops,
		Name:             "Loops",
		Category:         "marketing",
		AuthMode:         "loops_csv_export_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        loopsSyncModelNativeFoundation,
		VerificationMode: "loops_credential_ref_provider_row_delegated_csv_export_migration",
		Capabilities:     []string{"profiles", "lists"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "CSV export reference", Required: true, Secret: true, Help: "Vault reference containing Loops CSV export metadata; raw local file paths are rejected from settings"},
		},
		OptionalSettings: csvExportOptionalSettings("Loops", "audience or export"),
		Scopes:           []string{"csv_export:read"},
		SyncObjects:      []string{"contacts", "lists", "csv_export"},
		WebhookTopics:    []string{},
		DocsURL:          "/docs/integrations/loops",
	},
}

func csvExportOptionalSettings(providerName, scopeLabel string) []ProviderField {
	return []ProviderField{
		{Key: "account_id", Label: providerName + " " + scopeLabel + " ID", Help: "Optional provider-side " + scopeLabel + " identifier for operator audit"},
		{Key: "export_bundle_ref", Label: "Export bundle reference", Help: "Optional referenced export bundle or upload ID; raw local file paths stay out of settings"},
		{Key: "migration_job_id", Label: "Migration job ID", Help: "Temporary migration job used for CSV export import evidence"},
		{Key: "import_cursor", Label: "Import cursor", Help: "Optional delegated CSV migration cursor to preserve in the provider-row handoff cursor"},
	}
}

func ProviderSpecs() []ProviderSpec {
	out := append([]ProviderSpec(nil), providerSpecs...)
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func ProviderKeys() []string {
	out := make([]string, 0, len(providerSpecs))
	for _, spec := range providerSpecs {
		out = append(out, spec.Provider)
	}
	sort.Strings(out)
	return out
}

func ProviderSpecByKey(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range providerSpecs {
		if spec.Provider == key {
			return spec, true
		}
	}
	return ProviderSpec{}, false
}

func normalizeIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	if provider == "" {
		provider = ProviderKlaviyo
	}
	spec, ok := ProviderSpecByKey(provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, errors.New("unsupported marketing provider")
	}
	settings := cloneMap(in.Settings)
	credentialsRef := strings.TrimSpace(firstString(
		in.CredentialsRef,
		settingString(settings, "credentials_ref"),
		settingString(settings, "credential_ref"),
	))
	if containsRawCredentialSetting(settings) {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if credentialsRef == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("credentials_ref is required")
	}
	if looksLikeRawCredentialRef(credentialsRef) {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%w: credentials_ref looks like raw credential material", errRawCredentialSetting)
	}
	if spec.Provider == ProviderCustomerIO {
		region := strings.TrimSpace(settingString(settings, "region"))
		if region != "" {
			if region != "us" && region != "eu" {
				return IntegrationInput{}, ProviderSpec{}, errors.New("Customer.io region must be us or eu")
			}
			settings["region"] = region
		}
		workspaceID := strings.TrimSpace(settingString(settings, "workspace_id"))
		if workspaceID != "" {
			if !validCustomerIOWorkspaceMetadataID(workspaceID) {
				return IntegrationInput{}, ProviderSpec{}, errors.New("Customer.io workspace_id must contain 1 to 64 digits")
			}
			settings["workspace_id"] = workspaceID
		}
	}
	for _, field := range spec.RequiredSettings {
		if field.Key == "credentials_ref" || field.Key == "credential_ref" {
			continue
		}
		if strings.TrimSpace(settingString(settings, field.Key)) == "" {
			return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%s is required", field.Key)
		}
	}
	if err := integration_egress.ValidateSettings(integration_egress.FamilyMarketing, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	for _, key := range []string{"credentials_ref", "credential_ref", "provider_cleanup"} {
		delete(settings, key)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	settings["setup_surface"] = "marketing_integrations"
	settings["egress_policy_version"] = "v1"
	if spec.Provider == ProviderKlaviyo {
		settings["native_data_plane"] = "klaviyo_json_api_profiles_segments_source_events"
	} else {
		settings["delegated_data_plane"] = delegatedDataPlaneForProvider(spec.Provider)
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = spec.Name
	}
	status := strings.ToLower(strings.TrimSpace(in.Status))
	if status == "" {
		status = "connected"
	}
	if !allowedIntegrationStatus(status) {
		return IntegrationInput{}, ProviderSpec{}, errors.New("status must be connected, active, paused, error, or disconnected")
	}
	if status == "disconnected" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("status disconnected is reserved for the disconnect lifecycle")
	}
	return IntegrationInput{
		Provider:       spec.Provider,
		Name:           name,
		Status:         status,
		Scopes:         append([]string(nil), spec.Scopes...),
		CredentialsRef: credentialsRef,
		Settings:       settings,
	}, spec, nil
}

func validCustomerIOWorkspaceMetadataID(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func containsRawCredentialSetting(settings map[string]any) bool {
	for key, value := range settings {
		normalized := strings.ToLower(strings.TrimSpace(key))
		switch normalized {
		case "api_key", "private_api_key", "private_key", "private_app_token", "api_secret", "token", "access_token", "refresh_token", "client_secret", "secret", "password", "bearer_token", "webhook_secret", "cookie", "session_cookie", "substack_cookie", "csv_path", "subs_csv", "archive_csv", "archive_stats_csv", "file_path", "local_file_path":
			_ = value
			return true
		}
	}
	return false
}

func looksLikeRawCredentialRef(value string) bool {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	if trimmed == "" {
		return false
	}
	if strings.ContainsAny(trimmed, " \t\r\n") {
		return true
	}
	for _, prefix := range []string{
		"bearer ",
		"basic ",
		"sk_live_",
		"sk_test_",
		"rk_live_",
		"pk_live_",
		"pk_",
		"shpat_",
		"xoxb-",
		"xoxp-",
		"ya29.",
		"ghp_",
		"gho_",
		"github_pat_",
		"glpat-",
		"pat-",
		"eyj",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if strings.Count(trimmed, ".") >= 2 && strings.HasPrefix(trimmed, "eyJ") {
		return true
	}
	if len(trimmed) >= 80 && !strings.Contains(trimmed, "://") && !strings.Contains(trimmed, ":") {
		return true
	}
	return false
}

func allowedIntegrationStatus(status string) bool {
	switch status {
	case "connected", "active", "paused", "error", "disconnected":
		return true
	default:
		return false
	}
}

func delegatedDataPlaneForProvider(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderKlaviyo:
		return "klaviyo_migration_json_api_source_events"
	case ProviderMailchimp:
		return "mailchimp_migration_source_archive"
	case ProviderActiveCampaign:
		return "activecampaign_migration_api_v3_source_events"
	case ProviderCustomerIO:
		return "customerio_migration_app_api"
	case ProviderBrevo:
		return "brevo_migration_contacts_campaigns"
	case ProviderConvertKit:
		return "convertkit_migration_subscriber_broadcasts"
	case ProviderSubstack:
		return "substack_migration_export_archive"
	case ProviderBeehiiv:
		return "beehiiv_migration_api_v2_publications"
	case ProviderMailerLite:
		return "mailerlite_migration_connect_api"
	case ProviderSendy:
		return "sendy_migration_csv_export"
	case ProviderConstantContact:
		return "constant_contact_migration_csv_export"
	case ProviderAWeber:
		return "aweber_migration_csv_export"
	case ProviderDrip:
		return "drip_migration_csv_export"
	case ProviderCampaignMonitor:
		return "campaign_monitor_migration_csv_export"
	case ProviderOmnisend:
		return "omnisend_migration_csv_export"
	case ProviderLoops:
		return "loops_migration_csv_export"
	default:
		return provider + "_migration_adapter"
	}
}
