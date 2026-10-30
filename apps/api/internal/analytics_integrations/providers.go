// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

const (
	analyticsSyncModelIngest   = "postwave_analytics_ingest"
	postHogSyncModelPuller     = "posthog_persons_rest_backfill_scheduled_retry_live_certification"
	tripleWhaleSyncModelPuller = "triple_whale_customers_rest_backfill_scheduled_retry_live_certification"
	mixpanelSyncModelPuller    = "mixpanel_engage_profiles_rest_backfill_scheduled_retry_live_certification"
	amplitudeSyncModelPuller   = "amplitude_cohort_export_profiles_backfill_scheduled_retry_live_certification"
)

var analyticsCanonicalSyncObjects = []string{"profiles", "events"}
var analyticsCanonicalCapabilities = []string{"profiles", "events"}

func managedAnalyticsProviderSpec(provider, name, authMode string, required, optional []ProviderField, scopes, syncObjects, webhookTopics []string, caps []string) ProviderSpec {
	requiredSettings := append([]ProviderField(nil), required...)
	requiredSettings = append(requiredSettings, ProviderField{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing " + name + " API or OAuth credentials"})
	optionalSettings := append([]ProviderField(nil), optional...)
	return ProviderSpec{
		Provider:         provider,
		Name:             name,
		Category:         "analytics",
		AuthMode:         authMode,
		Managed:          true,
		RuntimeStatus:    "partial",
		Capabilities:     caps,
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
		Provider:      ProviderGA4,
		Name:          "Google Analytics 4",
		Category:      "analytics",
		AuthMode:      "api_secret_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"events", "warehouse_export", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "measurement_id", Label: "Measurement ID", Required: true, Help: "GA4 measurement ID, such as G-XXXXXXXXXX"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the GA4 API secret or service credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "property_id", Label: "Property ID", Help: "Optional GA4 property ID for reporting joins"},
			{Key: "stream_id", Label: "Stream ID", Help: "Optional GA4 data stream ID"},
		},
		Scopes:      []string{"measurement_protocol.write", "analytics.readonly"},
		SyncObjects: []string{"measurement_events", "reports", "properties", "data_streams", "campaign_attribution"},
		DocsURL:     "/docs/integrations/ga4",
	},
	{
		Provider:      ProviderGoogleTagManager,
		Name:          "Google Tag Manager",
		Category:      "analytics",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "container_id", Label: "Container ID", Required: true, Help: "GTM web container ID, such as GTM-XXXXXXX"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Google OAuth credentials for the Tag Manager API"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Help: "Optional GTM workspace for template publishing"},
			{Key: "server_container_url", Label: "Server container URL", Help: "Optional server-side GTM endpoint"},
		},
		Scopes:      []string{"tagmanager.readonly", "tagmanager.edit.containers", "tagmanager.publish"},
		SyncObjects: []string{"accounts", "containers", "workspaces", "tags", "triggers", "variables", "templates"},
		DocsURL:     "/docs/integrations/google-tag-manager",
	},
	{
		Provider:      ProviderSegment,
		Name:          "Segment",
		Category:      "cdp",
		AuthMode:      "write_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     analyticsSyncModelIngest,
		Capabilities:  []string{"profiles", "events", "warehouse_import", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "source_id", Label: "Source ID", Required: true, Help: "Segment source identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Segment write key or OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "workspace_slug", Label: "Workspace slug", Help: "Optional Segment workspace slug"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Segment webhook verification"},
		},
		Scopes:        []string{"identify.write", "track.write", "profiles.read", "webhooks.write"},
		SyncObjects:   []string{"identify", "track", "group", "page", "screen", "webhooks"},
		WebhookTopics: []string{"identify", "track", "group", "page", "screen"},
		DocsURL:       "/docs/integrations/segment",
	},
	{
		Provider:      ProviderRudderStack,
		Name:          "RudderStack",
		Category:      "cdp",
		AuthMode:      "write_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     analyticsSyncModelIngest,
		Capabilities:  []string{"profiles", "events", "warehouse_import", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "source_id", Label: "Source ID", Required: true, Help: "RudderStack source identifier"},
			{Key: "data_plane_url", Label: "Data plane URL", Required: true, Help: "RudderStack data plane endpoint"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing RudderStack write key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "rudderstack_ingest_token", Label: "Ingest token", Help: "Opaque token in the public RudderStack webhook ingest URL"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for the optional webhook Authorization header secret"},
			{Key: "workspace_slug", Label: "Workspace slug", Help: "Optional RudderStack workspace slug"},
		},
		Scopes:        []string{"identify.write", "track.write", "profiles.read", "webhooks.write"},
		SyncObjects:   []string{"identify", "track", "page", "screen", "webhooks"},
		WebhookTopics: []string{"identify", "track", "page", "screen"},
		DocsURL:       "/docs/integrations/rudderstack",
	},
	{
		Provider:         ProviderMixpanel,
		Name:             "Mixpanel",
		Category:         "analytics",
		AuthMode:         "service_account_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        mixpanelSyncModelPuller,
		VerificationMode: "mixpanel_engage_profile_puller_live_certification_pending",
		Capabilities:     []string{"profiles"},
		RequiredSettings: []ProviderField{
			{Key: "project_id", Label: "Project ID", Required: true, Help: "Mixpanel project identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing a service-account username and secret, or legacy project API secret; public project tokens cannot read profiles. Query API plan access is required"},
		},
		OptionalSettings: []ProviderField{
			{Key: "region", Label: "Region", Help: "Optional Mixpanel region, such as US or EU"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Mixpanel API base URL for regional or test routing"},
			{Key: "page_size", Label: "Page size", Help: "Optional profile page size hint; provider caps still apply"},
		},
		Scopes:      []string{"engage:read", "profiles:read"},
		SyncObjects: []string{"profiles"},
		DocsURL:     "/docs/integrations/mixpanel",
	},
	{
		Provider:         ProviderAmplitude,
		Name:             "Amplitude",
		Category:         "analytics",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        amplitudeSyncModelPuller,
		VerificationMode: "amplitude_cohort_export_profile_puller_live_certification_pending",
		Capabilities:     []string{"profiles"},
		RequiredSettings: []ProviderField{
			{Key: "cohort_id", Label: "Cohort ID", Required: true, Help: "Behavioral Cohort ID; export requires Behavioral Cohorts API entitlement, which Amplitude Free does not include"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Amplitude API key or secret"},
		},
		OptionalSettings: []ProviderField{
			{Key: "project_id", Label: "Project ID", Help: "Optional Amplitude project identifier for operator audit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Amplitude API base URL for regional or test routing"},
		},
		Scopes:      []string{"cohorts:read"},
		SyncObjects: []string{"profiles"},
		DocsURL:     "/docs/integrations/amplitude",
	},
	{
		Provider:         ProviderPostHog,
		Name:             "PostHog",
		Category:         "analytics",
		AuthMode:         "project_api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        postHogSyncModelPuller,
		VerificationMode: "posthog_persons_profile_puller_live_certification_pending",
		Capabilities:     []string{"profiles"},
		RequiredSettings: []ProviderField{
			{Key: "project_id", Label: "Project ID", Required: true, Help: "PostHog project identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing PostHog project or personal API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "host", Label: "Host", Help: "Optional PostHog host for cloud or self-hosted instances"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional PostHog API base URL for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Optional persons page size, capped by the runtime"},
		},
		Scopes:      []string{"persons:read"},
		SyncObjects: []string{"profiles"},
		DocsURL:     "/docs/integrations/posthog",
	},
	{
		Provider:      ProviderHeap,
		Name:          "Heap",
		Category:      "analytics",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "warehouse_export", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "environment_id", Label: "Environment ID", Required: true, Help: "Heap environment identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Heap API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "app_id", Label: "App ID", Help: "Optional Heap app identifier"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Heap webhook verification"},
		},
		Scopes:        []string{"events.write", "users.read", "segments.read", "exports.read"},
		SyncObjects:   []string{"events", "users", "segments", "properties", "exports"},
		WebhookTopics: []string{"event.created", "user.updated", "segment.updated"},
		DocsURL:       "/docs/integrations/heap",
	},
	{
		Provider:      ProviderHotjar,
		Name:          "Hotjar",
		Category:      "analytics",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Hotjar site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Hotjar API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Hotjar webhook verification"},
			{Key: "survey_id", Label: "Survey ID", Help: "Optional survey or feedback widget filter"},
		},
		Scopes:        []string{"events.write", "surveys.read", "feedback.read", "recordings.read"},
		SyncObjects:   []string{"events", "surveys", "feedback", "funnels", "recording_metadata"},
		WebhookTopics: []string{"survey.response", "feedback.response", "event.created"},
		DocsURL:       "/docs/integrations/hotjar",
	},
	{
		Provider:      ProviderFullStory,
		Name:          "FullStory",
		Category:      "analytics",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "warehouse_export", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "org_id", Label: "Org ID", Required: true, Help: "FullStory organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing FullStory API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for FullStory webhook verification"},
			{Key: "segment_id", Label: "Segment ID", Help: "Optional FullStory segment filter"},
		},
		Scopes:        []string{"events.write", "users.read", "segments.read", "exports.read"},
		SyncObjects:   []string{"events", "users", "segments", "sessions", "exports"},
		WebhookTopics: []string{"event.created", "user.updated", "segment.updated"},
		DocsURL:       "/docs/integrations/fullstory",
	},
	{
		Provider:      ProviderPlausible,
		Name:          "Plausible",
		Category:      "analytics",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"events", "warehouse_export", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_domain", Label: "Site domain", Required: true, Help: "Plausible site domain"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Plausible API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "host", Label: "Host", Help: "Optional Plausible host for self-hosted instances"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for custom event webhook verification"},
		},
		Scopes:        []string{"events.write", "stats.read", "sites.read"},
		SyncObjects:   []string{"events", "goals", "campaign_attribution", "stats", "site_metadata"},
		WebhookTopics: []string{"goal.conversion", "custom_event"},
		DocsURL:       "/docs/integrations/plausible",
	},
	managedAnalyticsProviderSpec(
		ProviderFathomAnalytics,
		"Fathom Analytics",
		"api_key_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Fathom site identifier"},
		},
		[]ProviderField{
			{Key: "site_domain", Label: "Site domain", Help: "Optional Fathom site domain for attribution joins"},
		},
		[]string{"events.write", "aggregations.read", "sites.read"},
		[]string{"events", "goals", "campaign_attribution", "aggregations", "site_metadata"},
		[]string{"goal.conversion", "custom_event"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderMatomo,
		"Matomo",
		"api_key_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Matomo website identifier"},
			{Key: "host", Label: "Host", Required: true, Help: "Matomo Cloud or self-hosted base URL"},
		},
		[]ProviderField{
			{Key: "segment_id", Label: "Segment ID", Help: "Optional Matomo segment filter"},
		},
		[]string{"events.write", "visits.read", "goals.read", "reports.read"},
		[]string{"events", "visits", "visitors", "goals", "campaign_attribution", "reports"},
		[]string{"goal.conversion", "custom_event"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderAdobeAnalytics,
		"Adobe Analytics",
		"oauth_ref",
		[]ProviderField{
			{Key: "company_id", Label: "Company ID", Required: true, Help: "Adobe Analytics company identifier"},
			{Key: "report_suite_id", Label: "Report suite ID", Required: true, Help: "Adobe Analytics report suite identifier"},
		},
		[]ProviderField{
			{Key: "global_company_id", Label: "Global company ID", Help: "Optional Adobe global company identifier"},
		},
		[]string{"openid", "AdobeID", "read_organizations", "additional_info.projectedProductContext", "analytics.read", "analytics.write"},
		[]string{"events", "visitors", "segments", "calculated_metrics", "report_suites", "reports"},
		[]string{"event.ingested", "segment.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderLookerStudio,
		"Looker Studio",
		"oauth_ref",
		[]ProviderField{
			{Key: "data_source_id", Label: "Data source ID", Required: true, Help: "Looker Studio data source identifier"},
		},
		[]ProviderField{
			{Key: "report_id", Label: "Report ID", Help: "Optional Looker Studio report identifier"},
		},
		[]string{"datastudio.read", "datastudio.write", "drive.metadata.readonly"},
		[]string{"data_sources", "reports", "fields", "extracts", "schema_metadata"},
		[]string{"data_source.refreshed", "report.updated"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderLooker,
		"Looker",
		"api_key_ref",
		[]ProviderField{
			{Key: "instance_url", Label: "Instance URL", Required: true, Help: "Looker instance URL"},
		},
		[]ProviderField{
			{Key: "model_id", Label: "Model ID", Help: "Optional Looker model filter"},
			{Key: "dashboard_id", Label: "Dashboard ID", Help: "Optional dashboard identifier for report sync"},
		},
		[]string{"looks.read", "dashboards.read", "queries.read", "schedules.read"},
		[]string{"looks", "dashboards", "queries", "explores", "models", "scheduled_exports"},
		[]string{"dashboard.updated", "scheduled_plan.completed"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderTableau,
		"Tableau",
		"personal_access_token_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Tableau site identifier"},
			{Key: "server_url", Label: "Server URL", Required: true, Help: "Tableau Cloud or Server URL"},
		},
		[]ProviderField{
			{Key: "workbook_id", Label: "Workbook ID", Help: "Optional workbook filter for refresh metadata"},
			{Key: "project_id", Label: "Project ID", Help: "Optional Tableau project filter"},
		},
		[]string{"workbooks.read", "views.read", "datasources.read", "jobs.read"},
		[]string{"workbooks", "views", "datasources", "extract_refreshes", "projects", "jobs"},
		[]string{"workbook.updated", "extract.refresh.completed"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderPowerBI,
		"Power BI",
		"oauth_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Power BI workspace identifier"},
			{Key: "dataset_id", Label: "Dataset ID", Required: true, Help: "Power BI dataset identifier"},
		},
		[]ProviderField{
			{Key: "report_id", Label: "Report ID", Help: "Optional Power BI report identifier"},
		},
		[]string{"Dataset.ReadWrite.All", "Report.Read.All", "Workspace.Read.All"},
		[]string{"datasets", "reports", "dashboards", "refreshes", "workspaces", "schema_metadata"},
		[]string{"dataset.refresh.completed", "report.updated"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderMode,
		"Mode",
		"api_key_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Mode workspace identifier"},
		},
		[]ProviderField{
			{Key: "report_id", Label: "Report ID", Help: "Optional Mode report identifier"},
			{Key: "collection_id", Label: "Collection ID", Help: "Optional collection filter"},
		},
		[]string{"reports.read", "queries.read", "runs.read", "schedules.read"},
		[]string{"reports", "queries", "runs", "collections", "schedules", "exports"},
		[]string{"report.run.completed", "report.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderMetabase,
		"Metabase",
		"api_key_ref",
		[]ProviderField{
			{Key: "instance_url", Label: "Instance URL", Required: true, Help: "Metabase instance URL"},
		},
		[]ProviderField{
			{Key: "database_id", Label: "Database ID", Help: "Optional Metabase database filter"},
			{Key: "collection_id", Label: "Collection ID", Help: "Optional collection filter"},
		},
		[]string{"cards.read", "dashboards.read", "databases.read", "pulses.read"},
		[]string{"cards", "dashboards", "questions", "databases", "collections", "pulses"},
		[]string{"dashboard.updated", "pulse.sent"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderSisense,
		"Sisense",
		"api_key_ref",
		[]ProviderField{
			{Key: "instance_url", Label: "Instance URL", Required: true, Help: "Sisense instance URL"},
		},
		[]ProviderField{
			{Key: "dashboard_id", Label: "Dashboard ID", Help: "Optional Sisense dashboard filter"},
			{Key: "datamodel_id", Label: "Data model ID", Help: "Optional Sisense data model identifier"},
		},
		[]string{"dashboards.read", "widgets.read", "datamodels.read", "jobs.read"},
		[]string{"dashboards", "widgets", "datamodels", "builds", "jobs", "exports"},
		[]string{"dashboard.updated", "datamodel.build.completed"},
		[]string{"events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderKissmetrics,
		"Kissmetrics",
		"api_key_ref",
		[]ProviderField{
			{Key: "product_id", Label: "Product ID", Required: true, Help: "Kissmetrics product or site identifier"},
		},
		[]ProviderField{
			{Key: "environment", Label: "Environment", Help: "Optional Kissmetrics environment filter"},
		},
		[]string{"events.write", "people.read", "reports.read"},
		[]string{"events", "people", "properties", "funnels", "cohorts", "reports"},
		[]string{"event.created", "person.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderWoopra,
		"Woopra",
		"api_key_ref",
		[]ProviderField{
			{Key: "project_id", Label: "Project ID", Required: true, Help: "Woopra project identifier"},
		},
		[]ProviderField{
			{Key: "domain", Label: "Domain", Help: "Optional Woopra site domain"},
		},
		[]string{"events.write", "profiles.read", "reports.read", "webhooks.write"},
		[]string{"events", "profiles", "journeys", "segments", "reports", "webhooks"},
		[]string{"event.created", "profile.updated", "segment.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderChartMogul,
		"ChartMogul",
		"api_key_ref",
		[]ProviderField{
			{Key: "data_source_uuid", Label: "Data source UUID", Required: true, Help: "ChartMogul data source UUID"},
		},
		[]ProviderField{
			{Key: "account_uuid", Label: "Account UUID", Help: "Optional ChartMogul account UUID"},
		},
		[]string{"customers.read", "subscriptions.read", "metrics.read", "activities.read"},
		[]string{"customers", "subscriptions", "plans", "activities", "mrr_movements", "metrics"},
		[]string{"customer.created", "subscription.updated", "mrr_movement.created"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderBaremetrics,
		"Baremetrics",
		"api_key_ref",
		[]ProviderField{
			{Key: "source_id", Label: "Source ID", Required: true, Help: "Baremetrics source identifier"},
		},
		[]ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional Baremetrics account identifier"},
		},
		[]string{"customers.read", "subscriptions.read", "metrics.read", "events.read"},
		[]string{"customers", "subscriptions", "plans", "events", "metrics", "segments"},
		[]string{"customer.created", "subscription.updated", "metric.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderProfitWell,
		"ProfitWell",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "ProfitWell account identifier"},
		},
		[]ProviderField{
			{Key: "product_id", Label: "Product ID", Help: "Optional product filter for ProfitWell metrics"},
		},
		[]string{"customers.read", "subscriptions.read", "metrics.read", "events.read"},
		[]string{"customers", "subscriptions", "products", "mrr", "churn", "retention"},
		[]string{"subscription.updated", "customer.updated", "metric.updated"},
		[]string{"profiles", "events", "warehouse_export", "automation_triggers"},
	),
	{
		Provider:         ProviderTripleWhale,
		Name:             "Triple Whale",
		Category:         "analytics",
		AuthMode:         "api_key_ref",
		Managed:          true,
		RuntimeStatus:    "partial",
		SyncModel:        tripleWhaleSyncModelPuller,
		VerificationMode: "triple_whale_customer_profile_puller_live_certification_pending",
		Capabilities:     []string{"profiles"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Triple Whale API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "shop_id", Label: "Shop ID", Help: "Exact shop-id from the Triple Whale app URL, including custom sales platforms; required here unless shop_id is in the credential secret"},
			{Key: "shop_domain", Label: "Shopify domain (legacy alias)", Help: "Optional Shopify shop domain; use Shop ID for custom sales platforms"},
			{Key: "start_date", Label: "Start date", Help: "Optional API query period start; customer profiles contain lifetime data"},
			{Key: "end_date", Label: "End date", Help: "Optional API query period end; customer profiles contain lifetime data"},
			{Key: "lookback_days", Label: "Lookback days", Help: "Optional rolling lookback when explicit dates are absent"},
			{Key: "page_size", Label: "Page size", Help: "Optional customer page size, capped by the runtime"},
			{Key: "endpoint", Label: "Endpoint", Help: "Optional Triple Whale customer endpoint override for certified/test environments"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Triple Whale API base URL for certified/test environments"},
		},
		Scopes:      []string{"summary-page:read", "attribution:read"},
		SyncObjects: []string{"profiles"},
		DocsURL:     "/docs/integrations/triple-whale",
	},
	managedAnalyticsProviderSpec(
		ProviderNorthbeam,
		"Northbeam",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Northbeam account identifier"},
		},
		[]ProviderField{
			{Key: "pixel_id", Label: "Pixel ID", Help: "Optional Northbeam pixel identifier"},
		},
		[]string{"orders.read", "customers.read", "attribution.read", "metrics.read"},
		[]string{"orders", "customers", "touchpoints", "attribution", "cohorts", "metrics"},
		[]string{"order.attributed", "touchpoint.created", "metric.updated"},
		[]string{"profiles", "events", "commerce", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderDaasity,
		"Daasity",
		"api_key_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Daasity workspace identifier"},
		},
		[]ProviderField{
			{Key: "model_id", Label: "Model ID", Help: "Optional Daasity model or report filter"},
		},
		[]string{"models.read", "reports.read", "metrics.read", "exports.read"},
		[]string{"models", "reports", "metrics", "cohorts", "exports", "schemas"},
		[]string{"model.updated", "export.completed", "metric.updated"},
		[]string{"profiles", "events", "warehouse_export", "warehouse_import", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderGlew,
		"Glew",
		"api_key_ref",
		[]ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Glew store identifier"},
		},
		[]ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional ecommerce shop domain"},
		},
		[]string{"customers.read", "orders.read", "products.read", "metrics.read"},
		[]string{"customers", "orders", "products", "cohorts", "segments", "metrics"},
		[]string{"customer.updated", "order.updated", "metric.updated"},
		[]string{"profiles", "events", "commerce", "warehouse_export", "automation_triggers"},
	),
	managedAnalyticsProviderSpec(
		ProviderPeelInsights,
		"Peel Insights",
		"api_key_ref",
		[]ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Peel Insights store identifier"},
		},
		[]ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional Shopify shop domain"},
		},
		[]string{"customers.read", "orders.read", "cohorts.read", "metrics.read"},
		[]string{"customers", "orders", "cohorts", "segments", "retention", "metrics"},
		[]string{"customer.updated", "order.updated", "cohort.updated"},
		[]string{"profiles", "events", "commerce", "warehouse_export", "automation_triggers"},
	),
}

func ProviderSpecs() []ProviderSpec {
	out := make([]ProviderSpec, 0, len(providerSpecs))
	for _, spec := range providerSpecs {
		out = append(out, withAnalyticsSpecDefaults(spec))
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
			return withAnalyticsSpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

func withAnalyticsSpecDefaults(spec ProviderSpec) ProviderSpec {
	// Capabilities, RequiredSettings, Scopes and SyncObjects carry no
	// `omitempty`, so a nil slice marshals to JSON null rather than being left
	// out. Clients type all four as arrays, and a provider that simply needs no
	// scopes -- the ordinary case for an API-key integration -- handed them a
	// null that throws on the first .map().
	//
	// OptionalSettings and WebhookTopics are deliberately untouched: they DO
	// carry `omitempty`, so nil means "absent field", which is a shape clients
	// already handle.
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
	if spec.SyncModel == "" {
		spec.SyncModel = analyticsSyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = analyticsVerificationMode(spec.Provider)
	}
	if spec.SyncModel == analyticsSyncModelIngest {
		spec.OptionalSettings = stripProviderFields(spec.OptionalSettings, "webhook_secret_ref")
		spec.Capabilities = append([]string(nil), analyticsCanonicalCapabilities...)
		// []string{}, not nil. This branch means "the ingest model has no OAuth
		// scopes", which is a true statement about an EMPTY set -- but Scopes
		// carries no `omitempty`, so nil says it in JSON as `null`, which is
		// what a client crashes on. The normalisation at the top of this
		// function cannot help: this assignment runs after it.
		//
		// WebhookTopics on the next line stays nil deliberately -- that field
		// DOES carry `omitempty`, so nil means "absent", not "null".
		spec.Scopes = []string{}
		spec.SyncObjects = append([]string(nil), analyticsCanonicalSyncObjects...)
		spec.WebhookTopics = nil
		spec.VerificationMode = "postwave_ingest_token"
	}
	return spec
}

func analyticsVerificationMode(provider string) string {
	switch provider {
	case ProviderGA4:
		return "ga4_measurement_protocol_api_secret_or_data_api_oauth_pending_adapter"
	case ProviderGoogleTagManager:
		return "google_tag_manager_oauth_pending_container_adapter"
	case ProviderSegment:
		return "segment_write_key_or_public_api_pending_adapter"
	case ProviderRudderStack:
		return "rudderstack_write_key_data_plane_pending_adapter"
	case ProviderMixpanel:
		return "mixpanel_service_account_or_project_secret_pending_adapter"
	case ProviderAmplitude:
		return "amplitude_api_key_secret_pending_adapter"
	case ProviderPostHog:
		return "posthog_project_key_or_personal_api_key_pending_adapter"
	case ProviderPlausible, ProviderFathomAnalytics, ProviderMatomo:
		return "privacy_analytics_api_key_pending_polling_adapter"
	case ProviderAdobeAnalytics:
		return "adobe_analytics_oauth_pending_adapter"
	case ProviderLookerStudio, ProviderLooker, ProviderTableau, ProviderPowerBI, ProviderMode, ProviderMetabase, ProviderSisense:
		return "bi_reporting_api_pending_adapter"
	case ProviderChartMogul, ProviderBaremetrics, ProviderProfitWell:
		return "subscription_revenue_api_pending_adapter"
	case ProviderTripleWhale, ProviderNorthbeam, ProviderDaasity, ProviderGlew, ProviderPeelInsights:
		return "commerce_attribution_api_pending_adapter"
	default:
		return "postwave_ingest_token"
	}
}

func stripProviderFields(fields []ProviderField, keys ...string) []ProviderField {
	if len(fields) == 0 || len(keys) == 0 {
		return fields
	}
	blocked := map[string]bool{}
	for _, key := range keys {
		blocked[strings.ToLower(strings.TrimSpace(key))] = true
	}
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if blocked[strings.ToLower(strings.TrimSpace(field.Key))] {
			continue
		}
		out = append(out, field)
	}
	return out
}

func normalizeIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("provider is required")
	}
	spec, ok := ProviderSpecByKey(in.Provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported analytics provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if spec.SyncModel == analyticsSyncModelIngest || analyticsProviderCleanupEligible(in.Provider) {
		stripUnverifiedWebhookCredentialRefs(settings)
	}
	credentialsRef := firstString(in.CredentialsRef, settingString(settings, "credentials_ref"), settingString(settings, "credential_ref"))
	if credentialsRef != "" {
		if looksLikeRawCredentialRef(credentialsRef) {
			return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%w: credentials_ref looks like raw credential material", errRawCredentialSetting)
		}
		settings["credentials_ref"] = credentialsRef
		delete(settings, "credential_ref")
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
	if err := integration_egress.ValidateSettings(integration_egress.FamilyAnalytics, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "measurement_id"),
			settingString(settings, "container_id"),
			settingString(settings, "source_id"),
			settingString(settings, "project_id"),
			settingString(settings, "environment_id"),
			settingString(settings, "site_id"),
			settingString(settings, "org_id"),
			settingString(settings, "site_domain"),
			settingString(settings, "company_id"),
			settingString(settings, "report_suite_id"),
			settingString(settings, "data_source_id"),
			settingString(settings, "instance_url"),
			settingString(settings, "server_url"),
			settingString(settings, "workspace_id"),
			settingString(settings, "dataset_id"),
			settingString(settings, "product_id"),
			settingString(settings, "data_source_uuid"),
			settingString(settings, "account_id"),
			settingString(settings, "shop_id"),
			settingString(settings, "shop_domain"),
			settingString(settings, "store_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if spec.SyncModel == analyticsSyncModelIngest {
		in.Scopes = nil
	} else if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	settings["setup_surface"] = "analytics_integrations"
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
	for i := range in.Profiles {
		in.Profiles[i].SourceID = strings.TrimSpace(in.Profiles[i].SourceID)
		in.Profiles[i].Email = strings.ToLower(strings.TrimSpace(in.Profiles[i].Email))
		in.Profiles[i].UserID = strings.TrimSpace(in.Profiles[i].UserID)
		in.Profiles[i].AnonymousID = strings.TrimSpace(in.Profiles[i].AnonymousID)
		in.Profiles[i].FirstName = strings.TrimSpace(in.Profiles[i].FirstName)
		in.Profiles[i].LastName = strings.TrimSpace(in.Profiles[i].LastName)
		in.Profiles[i].FullName = strings.TrimSpace(in.Profiles[i].FullName)
		in.Profiles[i].Phone = strings.TrimSpace(in.Profiles[i].Phone)
	}
	for i := range in.Events {
		in.Events[i].SourceID = strings.TrimSpace(in.Events[i].SourceID)
		in.Events[i].Email = strings.ToLower(strings.TrimSpace(in.Events[i].Email))
		in.Events[i].UserID = strings.TrimSpace(in.Events[i].UserID)
		in.Events[i].AnonymousID = strings.TrimSpace(in.Events[i].AnonymousID)
		in.Events[i].EventName = strings.TrimSpace(in.Events[i].EventName)
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
		"api_secret_ref_raw",
		"client_secret",
		"consumer_secret",
		"password",
		"private_app_token",
		"project_token",
		"refresh_token",
		"secret",
		"token",
		"webhook_secret",
		"write_key",
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
		"webhook_signature_ref",
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
