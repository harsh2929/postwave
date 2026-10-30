// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var (
	errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")
)

const crmSyncModelImport = "postwave_crm_import"
const closeSyncModelContactsREST = "close_contacts_rest_offset_backfill"
const copperSyncModelPeopleREST = "copper_people_rest_page_backfill"
const freshsalesSyncModelContactsREST = "freshsales_contacts_view_rest_page_backfill"
const postscriptSyncModelSubscribersREST = "postscript_sms_subscribers_rest"
const attentiveSyncModelSubscribersREST = "attentive_sms_subscribers_rest"

var providerSpecs = []ProviderSpec{
	{
		Provider:      ProviderHubSpot,
		Name:          "HubSpot",
		Category:      "crm",
		AuthMode:      "private_app_ref_or_managed_oauth",
		WebhookMode:   "managed_oauth_install_only",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "portal_id", Label: "Portal ID", Required: true, Help: "HubSpot account/portal identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the HubSpot private app token or managed OAuth token metadata"},
		},
		OptionalSettings: []ProviderField{
			{Key: "list_id", Label: "Default list ID", Help: "Optional HubSpot list ID to stamp onto synced contacts and use for configured membership fanout"},
			{Key: "sync_list_memberships", Label: "Sync list memberships", Help: "Set true to pull configured HubSpot list memberships after the contact backfill"},
			{Key: "membership_list_ids", Label: "Membership list IDs", Help: "Comma-separated or array of HubSpot list IDs to fan out through the Lists API"},
			{Key: "list_membership_map", Label: "List membership map", Help: "Optional HubSpot-list-ID to Moosewave-list-UUID map; proven HubSpot list memberships are then materialized into native Moosewave lists"},
			{Key: "membership_page_size", Label: "Membership page size", Help: "List-membership records per API page; capped at HubSpot's 100 contact-list limit"},
			{Key: "sync_deals", Label: "Sync deal events", Help: "Set true to pull associated HubSpot deals after contacts and configured list memberships complete"},
			{Key: "deal_page_size", Label: "Deal page size", Help: "Deals per API page; capped at HubSpot's 100 object-list limit"},
			{Key: "deal_properties", Label: "Deal properties", Help: "Comma-separated or array of additional deal properties to fetch for CRM event fanout"},
			{Key: "company_properties", Label: "Company properties", Help: "Comma-separated or array of company properties to fetch for deal-associated account evidence"},
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional API gateways; defaults to https://api.hubapi.com"},
			{Key: "api_version", Label: "API version", Help: "Defaults to HubSpot's current date-versioned 2026-03 CRM API; set v3 for legacy path compatibility"},
			{Key: "properties", Label: "Extra contact properties", Help: "Comma-separated or array of additional contact properties to fetch"},
			{Key: "page_size", Label: "Page size", Help: "Contacts per API page; capped at HubSpot's 100 contact list limit"},
		},
		Scopes:        []string{"crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.companies.read", "crm.lists.read", "oauth"},
		SyncObjects:   []string{"contacts", "list_memberships", "deal_events", "oauth_app_webhooks"},
		WebhookTopics: []string{"contact.creation", "contact.propertyChange", "contact.deletion"},
		DocsURL:       "/docs/integrations/hubspot",
	},
	{
		Provider:      ProviderSalesforce,
		Name:          "Salesforce",
		Category:      "crm",
		AuthMode:      "connected_app_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "org_id", Label: "Org ID", Required: true, Help: "Salesforce organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Salesforce connected-app credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "instance_url", Label: "Instance URL", Help: "Salesforce org instance URL, for example https://example.my.salesforce.com; may also live in the credential secret"},
			{Key: "api_version", Label: "API version", Help: "Defaults to Salesforce REST API v67.0 for Summer '26; override for older orgs"},
			{Key: "batch_size", Label: "SOQL batch size", Help: "Sforce-Query-Options batch size; defaults to 200 and is capped at 2000"},
			{Key: "campaign_id", Label: "Default Campaign ID", Help: "Optional default campaign/list ID stamped on synced Salesforce rows"},
			{Key: "campaign_membership_map", Label: "Campaign membership map", Help: "Optional Salesforce Campaign ID to Moosewave list UUID map; CampaignMember events are then materialized into native Moosewave lists"},
			{Key: "sync_campaign_members", Label: "Sync Campaign Members", Help: "Set false to skip CampaignMember event fanout"},
			{Key: "campaign_member_fields", Label: "Campaign Member Fields", Help: "Comma-separated or array of extra CampaignMember SOQL fields"},
			{Key: "sync_tasks", Label: "Sync Tasks", Help: "Set false to skip Salesforce Task activity fanout"},
			{Key: "task_fields", Label: "Task Fields", Help: "Comma-separated or array of extra Task SOQL fields"},
		},
		Scopes:        []string{"api", "refresh_token", "offline_access"},
		SyncObjects:   []string{"contacts", "leads", "campaign_members", "tasks"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/salesforce",
	},
	{
		Provider:      ProviderPipedrive,
		Name:          "Pipedrive",
		Category:      "crm",
		AuthMode:      "managed_oauth_or_api_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "company_domain", Label: "Company domain", Required: true, Help: "Pipedrive company domain or tenant slug"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Pipedrive API token or OAuth token metadata"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional gateways; defaults to https://{company_domain}.pipedrive.com"},
			{Key: "limit", Label: "Page size", Help: "Persons/deals/organizations/activities per API page; capped at Pipedrive's v2 maximum of 500"},
			{Key: "sync_deals", Label: "Sync deals", Help: "Set false to skip Pipedrive Deals"},
			{Key: "deal_status", Label: "Deal status", Help: "Optional Pipedrive deal status filter such as open, won, lost, or deleted"},
			{Key: "deal_filter_id", Label: "Deal filter ID", Help: "Optional Pipedrive deal filter ID"},
			{Key: "deal_updated_since", Label: "Deal updated since", Help: "Optional RFC3339 lower bound for deal update_time"},
			{Key: "sync_organizations", Label: "Sync organizations", Help: "Set false to skip Pipedrive Organizations/account enrichment"},
			{Key: "organization_filter_id", Label: "Organization filter ID", Help: "Optional Pipedrive organization filter ID"},
			{Key: "organization_updated_since", Label: "Organization updated since", Help: "Optional RFC3339 lower bound for organization update_time"},
			{Key: "sync_activities", Label: "Sync activities", Help: "Set false to skip Pipedrive Activities/task event fanout"},
			{Key: "activity_filter_id", Label: "Activity filter ID", Help: "Optional Pipedrive activity filter ID"},
			{Key: "activity_updated_since", Label: "Activity updated since", Help: "Optional RFC3339 lower bound for activity update_time"},
			{Key: "activity_done", Label: "Activity done filter", Help: "Optional true/false filter for completed or open activities"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Pipedrive persons"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Pipedrive persons"},
			{Key: "pipeline_id", Label: "Pipeline ID", Help: "Optional Pipedrive pipeline filter for deal fanout"},
			{Key: "manage_webhooks", Label: "Manage webhooks", Help: "Set true to register Moosewave-owned Pipedrive person/deal/organization/activity webhooks; Basic Auth credentials must live in credentials_ref"},
			{Key: "webhook_events", Label: "Webhook events", Help: "Optional comma-separated Pipedrive event list such as create.person,change.deal,change.organization,change.activity"},
		},
		Scopes:        []string{"contacts:read", "deals:read", "activities:read", "webhooks:full"},
		SyncObjects:   []string{"persons", "deals", "organizations", "activities", "webhooks"},
		WebhookTopics: []string{"create.person", "change.person", "delete.person", "create.deal", "change.deal", "delete.deal", "create.organization", "change.organization", "delete.organization", "create.activity", "change.activity", "delete.activity"},
		DocsURL:       "/docs/integrations/pipedrive",
	},
	{
		Provider:      ProviderZohoCRM,
		Name:          "Zoho CRM",
		Category:      "crm",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Required: true, Help: "Zoho CRM organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Zoho OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "data_center", Label: "Data center", Help: "Optional Zoho data center, for example us, eu, in, au, or jp"},
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional gateways; defaults from data_center"},
			{Key: "api_version", Label: "API version", Help: "Defaults to Zoho CRM API v8"},
			{Key: "per_page", Label: "Page size", Help: "Records per API page; capped at Zoho's 200 record limit"},
			{Key: "list_view_id", Label: "List view ID", Help: "Optional Zoho CRM custom view ID to stamp onto synced contacts and use as cvid for first-page pulls"},
			{Key: "sync_leads", Label: "Sync leads", Help: "Set false to sync Contacts only"},
			{Key: "converted", Label: "Lead converted filter", Help: "Optional Zoho Leads converted filter"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Contacts and Leads"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Contacts and Leads"},
			{Key: "fields", Label: "Extra fields", Help: "Optional comma-separated or array of Zoho fields to request"},
			{Key: "contacts_fields", Label: "Contact fields", Help: "Optional Zoho Contact fields to request"},
			{Key: "leads_fields", Label: "Lead fields", Help: "Optional Zoho Lead fields to request"},
			{Key: "notification_channel_id", Label: "Notification channel ID", Help: "Optional Zoho notification channel ID for webhook delivery"},
			{Key: "notification_token_ref", Label: "Notification token reference", Help: "Vault reference for the Zoho notification callback token"},
		},
		Scopes:        []string{"ZohoCRM.modules.Contacts.READ", "ZohoCRM.modules.Leads.READ", "ZohoCRM.modules.Accounts.READ", "ZohoCRM.notifications.CREATE"},
		SyncObjects:   []string{"contacts", "leads", "accounts", "deals", "campaigns", "activities", "webhooks"},
		WebhookTopics: []string{"contacts.create", "contacts.edit", "leads.create", "leads.edit", "deals.edit"},
		DocsURL:       "/docs/integrations/zoho-crm",
	},
	{
		Provider:      ProviderDynamics365,
		Name:          "Microsoft Dynamics 365",
		Category:      "crm",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "environment_url", Label: "Environment URL", Required: true, Help: "Dynamics 365 Dataverse environment URL"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Microsoft OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "tenant_id", Label: "Microsoft tenant ID", Help: "Optional Microsoft Entra tenant identifier"},
			{Key: "api_version", Label: "API version", Help: "Defaults to Dataverse Web API v9.2"},
			{Key: "page_size", Label: "Page size", Help: "Records per API page; capped at Dataverse's 5,000 row maximum"},
			{Key: "sync_leads", Label: "Sync leads", Help: "Set false to sync Contacts only"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Contacts and Leads"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Contacts and Leads"},
			{Key: "fields", Label: "Extra fields", Help: "Optional comma-separated or array of Dataverse fields to request"},
			{Key: "contacts_fields", Label: "Contact fields", Help: "Optional Dataverse Contact fields to request"},
			{Key: "leads_fields", Label: "Lead fields", Help: "Optional Dataverse Lead fields to request"},
			{Key: "business_unit_id", Label: "Business unit ID", Help: "Optional Dynamics business unit evidence; filtering remains partial"},
		},
		Scopes:        []string{"{environment_url}/user_impersonation", "offline_access"},
		SyncObjects:   []string{"contacts", "leads", "accounts", "opportunities", "marketing_lists", "activities", "webhooks"},
		WebhookTopics: []string{"contact.created", "contact.updated", "lead.created", "lead.updated", "opportunity.updated"},
		DocsURL:       "/docs/integrations/microsoft-dynamics-365",
	},
	{
		Provider:      ProviderKeap,
		Name:          "Keap",
		Category:      "crm",
		AuthMode:      "oauth_or_api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Keap account identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Keap OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional gateways; defaults to https://api.infusionsoft.com/crm"},
			{Key: "page_size", Label: "Page size", Help: "Contacts per API page; capped at Keap REST v2's 1,000 record maximum"},
			{Key: "filter", Label: "Filter", Help: "Optional Keap REST v2 contact filter, for example start_update_time==..."},
			{Key: "order_by", Label: "Order by", Help: "Optional Keap REST v2 order, for example update_time asc"},
			{Key: "fields", Label: "Extra fields", Help: "Optional comma-separated or array of Keap Contact fields to request"},
			{Key: "contacts_fields", Label: "Contact fields", Help: "Optional Keap Contact fields to request"},
			{Key: "tag_id", Label: "Tag ID", Help: "Optional Keap tag ID to use the tagged-contact list endpoint for this first slice; full tag membership fanout remains partial"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Keap contacts"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Keap contacts"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Keap webhook validation"},
		},
		Scopes:        []string{"contacts.read", "tags.read", "campaigns.read", "orders.read", "webhooks.write"},
		SyncObjects:   []string{"contacts", "tags", "campaigns", "orders", "appointments", "webhooks"},
		WebhookTopics: []string{"contact.add", "contact.edit", "tag.add", "order.add", "appointment.add"},
		DocsURL:       "/docs/integrations/keap",
	},
	{
		Provider:      ProviderClose,
		Name:          "Close",
		Category:      "crm",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Required: true, Help: "Close organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Close API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional API gateways; defaults to https://api.close.com"},
			{Key: "page_size", Label: "Page size", Help: "Contacts per API page; capped at Close's local connector limit"},
			{Key: "lead_status_id", Label: "Lead status ID", Help: "Optional default lead status filter"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Close contacts"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Close contacts"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave Close webhook URL for route-level tenant isolation"},
		},
		Scopes:        []string{"contacts.read", "leads.read", "opportunities.read", "activities.read", "webhooks.write"},
		SyncObjects:   []string{"contacts", "leads", "opportunities", "activities", "tasks", "webhooks"},
		WebhookTopics: []string{"lead.created", "lead.updated", "contact.created", "contact.updated", "opportunity.updated"},
		DocsURL:       "/docs/integrations/close",
	},
	{
		Provider:      ProviderCopper,
		Name:          "Copper",
		Category:      "crm",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Copper account identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Copper API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional API gateways; defaults to https://api.copper.com/developer_api/v1"},
			{Key: "page_size", Label: "Page size", Help: "People, companies, opportunities, projects, or activities per API page; capped at Copper's local connector limit"},
			{Key: "pipeline_id", Label: "Pipeline ID", Help: "Optional Copper opportunity pipeline filter"},
			{Key: "sync_companies", Label: "Sync companies", Help: "Set false to skip company primary-contact enrichment during Copper backfills"},
			{Key: "sync_opportunities", Label: "Sync opportunities", Help: "Set false to skip opportunity event backfills"},
			{Key: "sync_projects", Label: "Sync projects", Help: "Set false to skip project event backfills"},
			{Key: "sync_activities", Label: "Sync activities", Help: "Set false to skip activity event backfills"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Copper people"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Copper people"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave Copper webhook URL for route-level tenant isolation"},
			{Key: "copper_webhook_subscription_id", Label: "Webhook subscription ID", Help: "Optional Copper webhook subscription ID used to fail closed on mismatched callbacks"},
		},
		Scopes:        []string{"people.read", "companies.read", "opportunities.read", "projects.read", "activities.read", "webhooks.write"},
		SyncObjects:   []string{"people", "companies", "opportunities", "activities", "projects", "webhooks"},
		WebhookTopics: []string{"person.created", "person.updated", "company.created", "company.updated", "opportunity.created", "opportunity.updated", "project.created", "project.updated", "activity.created", "activity.updated"},
		DocsURL:       "/docs/integrations/copper",
	},
	{
		Provider:      ProviderFreshsales,
		Name:          "Freshsales",
		Category:      "crm",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Freshsales account domain"},
			{Key: "view_id", Label: "Contact view ID", Required: true, Help: "Freshsales contact view used for the current native contact pull"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Freshsales API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional API gateways; defaults from the account domain"},
			{Key: "page_size", Label: "Page size", Help: "Contacts per API page; capped at Freshsales' local connector limit"},
			{Key: "account_view_id", Label: "Account view ID", Help: "Optional Freshsales sales account view used for native account-contact enrichment"},
			{Key: "account_page_size", Label: "Account page size", Help: "Sales accounts per API page; capped at Freshsales' local connector limit"},
			{Key: "deal_view_id", Label: "Deal view ID", Help: "Optional Freshsales deal view used for native deal event backfill"},
			{Key: "sync_sales_activities", Label: "Sync sales activities", Help: "Set true to enable Freshsales sales activity event backfill for contact-, deal-, and account-targeted activities"},
			{Key: "activity_page_size", Label: "Activity page size", Help: "Sales activities per API page; capped at Freshsales' local connector limit"},
			{Key: "sync_tasks", Label: "Sync tasks", Help: "Set true to enable Freshsales task event backfill for contact-, deal-, and account-targeted tasks"},
			{Key: "task_filter", Label: "Task filter", Help: "Freshsales task filter for task backfill; defaults to open"},
			{Key: "task_page_size", Label: "Task page size", Help: "Tasks per API page; capped at Freshsales' local connector limit"},
			{Key: "sales_pipeline_id", Label: "Sales pipeline ID", Help: "Optional Freshsales pipeline filter"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Freshsales contacts"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Freshsales contacts"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave Freshsales workflow webhook URL for route-level tenant isolation"},
		},
		Scopes:        []string{"contacts.read", "accounts.read", "deals.read", "activities.read", "webhooks.write"},
		SyncObjects:   []string{"contacts", "accounts", "deals", "activities", "tasks", "webhooks"},
		WebhookTopics: []string{"contact.created", "contact.updated", "deal.created", "deal.updated", "account.updated"},
		DocsURL:       "/docs/integrations/freshsales",
	},
	{
		Provider:      ProviderHighLevel,
		Name:          "HighLevel",
		Category:      "crm",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "location_id", Label: "Location ID", Required: true, Help: "HighLevel location identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing HighLevel OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional API gateways; defaults to https://services.leadconnectorhq.com"},
			{Key: "page_size", Label: "Page size", Help: "Contacts, opportunities, calendars, appointments, or conversations per API page; capped at HighLevel's local connector limit"},
			{Key: "company_id", Label: "Company ID", Help: "Optional HighLevel company identifier"},
			{Key: "pipeline_id", Label: "Pipeline ID", Help: "Optional HighLevel opportunity pipeline filter"},
			{Key: "calendar_id", Label: "Calendar ID", Help: "Optional HighLevel calendar filter for appointment event pulls"},
			{Key: "calendar_start_time", Label: "Calendar start time", Help: "Optional RFC3339 start bound for HighLevel appointment pulls"},
			{Key: "calendar_end_time", Label: "Calendar end time", Help: "Optional RFC3339 end bound for HighLevel appointment pulls"},
			{Key: "sync_opportunities", Label: "Sync opportunities", Help: "Set true to enable opt-in HighLevel opportunity event backfills"},
			{Key: "sync_calendars", Label: "Sync calendars", Help: "Set true to enable opt-in HighLevel calendar inventory pulls"},
			{Key: "sync_appointments", Label: "Sync appointments", Help: "Set true to enable opt-in HighLevel appointment event backfills"},
			{Key: "sync_conversations", Label: "Sync conversations", Help: "Set true to enable opt-in HighLevel conversation event backfills"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced HighLevel contacts"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced HighLevel contacts"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave HighLevel webhook URL for route-level tenant and location isolation"},
		},
		Scopes:        []string{"contacts.readonly", "opportunities.readonly", "calendars.readonly", "calendars/events.readonly", "conversations.readonly", "conversations/message.readonly", "webhooks.receive"},
		SyncObjects:   []string{"contacts", "opportunity_events", "calendars", "appointment_events", "conversation_events", "webhook_events"},
		WebhookTopics: []string{"contact.created", "contact.updated", "opportunity.created", "opportunity.updated", "appointment.created", "appointment.updated", "conversation.updated", "message.created"},
		DocsURL:       "/docs/integrations/highlevel",
	},
	{
		Provider:      ProviderPostscript,
		Name:          "Postscript",
		Category:      "crm",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Postscript API-key material"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional gateways; defaults to Postscript's subscriber API host"},
			{Key: "page_size", Label: "Page size", Help: "Subscribers per API page; capped at Postscript's local connector limit of 500"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Postscript subscribers"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Postscript subscribers"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave Postscript webhook URL for route-level tenant isolation"},
		},
		Scopes:        []string{"subscribers.read", "webhooks.receive"},
		SyncObjects:   []string{"subscribers", "webhook_events"},
		WebhookTopics: []string{"shop.incoming_message", "shop.subscriber.opt_in", "shop.subscriber.opt_out"},
		DocsURL:       "/docs/integrations/postscript",
	},
	{
		Provider:      ProviderAttentive,
		Name:          "Attentive",
		Category:      "crm",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "lists", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Attentive API-key material"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Override for tests or regional gateways; defaults to Attentive's subscriber API host"},
			{Key: "page_size", Label: "Page size", Help: "Subscribers per API page; capped at Attentive's local connector limit of 1000"},
			{Key: "default_tags", Label: "Default tags", Help: "Optional comma-separated or array of Moosewave tags to stamp onto synced Attentive subscribers"},
			{Key: "list_ids", Label: "Default list IDs", Help: "Optional Moosewave list IDs to stamp onto synced Attentive subscribers"},
			{Key: "webhook_route_token", Label: "Webhook route token", Help: "Opaque token embedded in the Moosewave Attentive webhook URL for route-level tenant isolation"},
		},
		Scopes:        []string{"subscribers.read", "webhooks.receive"},
		SyncObjects:   []string{"subscribers", "webhook_events"},
		WebhookTopics: []string{"sms.subscribed", "sms.unsubscribed", "sms.inbound_message", "sms.sent", "sms.message_link_click", "custom_attribute.set"},
		DocsURL:       "/docs/integrations/attentive",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := make([]ProviderSpec, 0, len(providerSpecs))
	for _, spec := range providerSpecs {
		out = append(out, crmFoundationSpec(spec))
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
			return crmFoundationSpec(spec), true
		}
	}
	return ProviderSpec{}, false
}

func crmFoundationSpec(spec ProviderSpec) ProviderSpec {
	spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
	spec.OptionalSettings = withoutCRMProviderRuntimeFields(spec.OptionalSettings)
	spec.Capabilities = append([]string(nil), spec.Capabilities...)
	if spec.Provider == ProviderHubSpot {
		spec.Capabilities = []string{"profiles", "events", "lists"}
		spec.Scopes = []string{"crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.companies.read", "crm.lists.read", "oauth"}
		spec.SyncObjects = []string{"contacts", "list_memberships", "deal_events", "oauth_app_webhooks"}
		spec.WebhookTopics = []string{"contact.creation", "contact.propertyChange", "contact.deletion"}
		spec.SyncModel = hubSpotSyncModelContactsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderSalesforce {
		spec.Capabilities = []string{"profiles", "events"}
		spec.Scopes = []string{"api", "refresh_token", "offline_access"}
		spec.SyncObjects = []string{"contacts", "leads", "campaign_members", "tasks"}
		spec.WebhookTopics = []string{}
		spec.SyncModel = salesforceSyncModelSOQL
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderPipedrive {
		spec.Capabilities = []string{"profiles", "events", "automation_triggers"}
		spec.Scopes = []string{"contacts:read", "deals:read", "activities:read", "webhooks:full"}
		spec.SyncObjects = []string{"persons", "deals", "organizations", "activities", "webhooks"}
		spec.WebhookTopics = []string{"create.person", "change.person", "delete.person", "create.deal", "change.deal", "delete.deal", "create.organization", "change.organization", "delete.organization", "create.activity", "change.activity", "delete.activity"}
		spec.SyncModel = pipedriveSyncModelPersonsDealsOrgsActivitiesREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderZohoCRM {
		spec.Capabilities = []string{"profiles"}
		spec.Scopes = []string{"ZohoCRM.modules.Contacts.READ", "ZohoCRM.modules.Leads.READ"}
		spec.SyncObjects = []string{"contacts", "leads"}
		spec.WebhookTopics = []string{}
		spec.SyncModel = zohoSyncModelRecordsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderDynamics365 {
		spec.Capabilities = []string{"profiles"}
		spec.Scopes = []string{"{environment_url}/user_impersonation", "offline_access"}
		spec.SyncObjects = []string{"contacts", "leads"}
		spec.WebhookTopics = []string{}
		spec.SyncModel = dynamics365SyncModelDataverseREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderKeap {
		spec.Capabilities = []string{"profiles"}
		spec.Scopes = []string{"full"}
		spec.SyncObjects = []string{"contacts"}
		spec.WebhookTopics = []string{}
		spec.SyncModel = keapSyncModelContactsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderClose {
		spec.Capabilities = []string{"profiles", "events", "automation_triggers"}
		spec.Scopes = []string{"contacts.read", "leads.read", "webhooks.receive"}
		spec.SyncObjects = []string{"contacts", "webhook_events", "opportunity_events", "task_events", "activity_events"}
		spec.WebhookTopics = []string{"contact.created", "contact.updated", "contact.deleted", "opportunity.created", "opportunity.updated", "opportunity.deleted", "task.created", "task.updated", "task.deleted", "activity.created", "activity.updated", "activity.deleted"}
		spec.SyncModel = closeSyncModelContactsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderCopper {
		spec.Capabilities = []string{"profiles", "events", "automation_triggers"}
		spec.Scopes = []string{"people.read", "companies.read", "opportunities.read", "projects.read", "activities.read", "webhooks.receive"}
		spec.SyncObjects = []string{"people", "company_contacts", "opportunity_events", "project_events", "activity_events", "webhook_events"}
		spec.WebhookTopics = []string{"person.created", "person.updated", "company.created", "company.updated", "opportunity.created", "opportunity.updated", "project.created", "project.updated", "activity.created", "activity.updated"}
		spec.SyncModel = copperSyncModelPeopleREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderFreshsales {
		spec.Capabilities = []string{"profiles", "events", "automation_triggers"}
		spec.Scopes = []string{"contacts.read", "accounts.read", "deals.read", "activities.read", "tasks.read", "webhooks.receive"}
		spec.SyncObjects = []string{"contacts", "account_contacts", "deal_events", "activity_events", "task_events", "webhook_events"}
		spec.WebhookTopics = []string{"contact.created", "contact.updated"}
		spec.SyncModel = freshsalesSyncModelContactsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderHighLevel {
		spec.Capabilities = []string{"profiles", "events", "automation_triggers"}
		spec.Scopes = []string{"contacts.readonly", "opportunities.readonly", "calendars.readonly", "calendars/events.readonly", "conversations.readonly", "conversations/message.readonly", "webhooks.receive"}
		spec.SyncObjects = []string{"contacts", "opportunity_events", "calendars", "appointment_events", "conversation_events", "webhook_events"}
		spec.WebhookTopics = []string{"contact.created", "contact.updated", "opportunity.created", "opportunity.updated", "appointment.created", "appointment.updated", "conversation.updated", "message.created"}
		spec.SyncModel = highLevelSyncModelContactsREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderPostscript {
		spec.Capabilities = []string{"profiles", "events", "lists", "segments", "automation_triggers"}
		spec.Scopes = []string{"subscribers.read", "webhooks.receive"}
		spec.SyncObjects = []string{"subscribers", "webhook_events"}
		spec.WebhookTopics = []string{"shop.incoming_message", "shop.subscriber.opt_in", "shop.subscriber.opt_out"}
		spec.SyncModel = postscriptSyncModelSubscribersREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderAttentive {
		spec.Capabilities = []string{"profiles", "events", "lists", "segments", "automation_triggers"}
		spec.Scopes = []string{"subscribers.read", "webhooks.receive"}
		spec.SyncObjects = []string{"subscribers", "webhook_events"}
		spec.WebhookTopics = []string{"sms.subscribed", "sms.unsubscribed", "sms.inbound_message", "sms.sent", "sms.message_link_click", "custom_attribute.set"}
		spec.SyncModel = attentiveSyncModelSubscribersREST
		spec.VerificationMode = crmVerificationMode(spec.Provider)
		return spec
	}
	spec.Scopes = []string{}
	spec.SyncObjects = []string{"contacts", "events"}
	spec.WebhookTopics = []string{}
	spec.SyncModel = crmSyncModelImport
	spec.VerificationMode = crmVerificationMode(spec.Provider)
	return spec
}

func crmVerificationMode(provider string) string {
	switch provider {
	case ProviderHubSpot:
		return "hubspot_oauth_contacts_list_memberships_deal_events_webhooks_scheduled_retry_pending_live_certification"
	case ProviderSalesforce:
		return "salesforce_connected_app_soql_contacts_leads_campaign_members_tasks_live_certification_pending"
	case ProviderPipedrive:
		return "pipedrive_oauth_persons_deals_organizations_activities_webhooks_pending_live_certification"
	case ProviderZohoCRM:
		return "zoho_oauth_v8_contacts_leads_scheduled_retry_pending_notifications_accounts_deals_activities_cleanup_certification"
	case ProviderDynamics365:
		return "dataverse_oauth_contacts_leads_scheduled_retry_pending_change_tracking_lists_opportunities_activities_cleanup_certification"
	case ProviderKeap:
		return "keap_rest_v2_contacts_scheduled_retry_pending_tags_campaigns_orders_webhooks_cleanup_certification"
	case ProviderClose:
		return "close_api_key_contacts_rest_signed_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification"
	case ProviderCopper:
		return "copper_api_key_people_companies_opportunities_projects_activities_rest_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification"
	case ProviderFreshsales:
		return "freshsales_api_key_contacts_accounts_deals_contact_deal_account_targeted_sales_activities_tasks_route_token_workflow_webhooks_scheduled_retry_cleanup_pending_live_certification"
	case ProviderHighLevel:
		return "highlevel_oauth_contacts_opportunities_calendars_appointments_conversations_rest_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification"
	case ProviderPostscript:
		return "postscript_sms_subscribers_rest_phone_identity_route_token_signed_webhooks_scheduled_retry_cleanup_pending_live_certification"
	case ProviderAttentive:
		return "attentive_sms_subscribers_rest_phone_identity_route_token_hmac_webhooks_scheduled_retry_cleanup_pending_live_certification"
	default:
		return "postwave_crm_import_pending_provider_adapter"
	}
}

func withoutCRMProviderRuntimeFields(fields []ProviderField) []ProviderField {
	remove := map[string]bool{
		"notification_channel_id": true,
		"notification_token_ref":  true,
		"webhook_auth_ref":        true,
		"webhook_secret_ref":      true,
		"webhook_signature_ref":   true,
	}
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if remove[strings.ToLower(strings.TrimSpace(field.Key))] {
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
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported CRM provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	stripCRMProviderRuntimeSettings(settings)
	if !in.TrustedRuntimeMetadata {
		stripHubSpotRuntimeMetadata(settings)
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
	if err := integration_egress.ValidateSettings(integration_egress.FamilyCRM, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "portal_id"),
			settingString(settings, "org_id"),
			settingString(settings, "organization_id"),
			settingString(settings, "account_id"),
			settingString(settings, "company_domain"),
			settingString(settings, "account_domain"),
			settingString(settings, "location_id"),
			settingString(settings, "environment_url"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if spec.SyncModel == crmSyncModelImport {
		in.Scopes = []string{}
	} else if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["setup_surface"] = "crm_integrations"
	settings["egress_policy_version"] = "v1"
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	if spec.Provider == ProviderHubSpot {
		if in.TrustedRuntimeMetadata &&
			settingEnabled(settings, "hubspot_oauth_managed_by_postwave") &&
			settingString(settings, "hubspot_app_id") != "" {
			settings["hubspot_auth_mode"] = "managed_oauth"
			settings["hubspot_webhook_mode"] = "app_level_oauth_install"
		} else {
			settings["hubspot_auth_mode"] = "private_app"
			settings["hubspot_webhook_mode"] = "polling_only"
		}
	}
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func stripCRMProviderRuntimeSettings(settings map[string]any) {
	for _, key := range []string{
		"notification_channel_id",
		"notification_token_ref",
		"provider_cleanup",
		"webhook_auth_ref",
		"webhook_secret_ref",
		"webhook_signature_ref",
	} {
		delete(settings, key)
	}
}

func stripHubSpotRuntimeMetadata(settings map[string]any) {
	for _, key := range []string{
		"hubspot_app_id",
		"hubspot_auth_mode",
		"hubspot_hub_domain",
		"hubspot_oauth_connected_at",
		"hubspot_oauth_managed_by_postwave",
		"hubspot_oauth_scopes",
		"hubspot_portal_id",
		"hubspot_webhook_mode",
	} {
		delete(settings, key)
	}
}

func settingEnabled(settings map[string]any, key string) bool {
	switch strings.ToLower(settingString(settings, key)) {
	case "true", "1", "yes":
		return true
	default:
		return false
	}
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(in.RunMode))
	if in.RunMode == "" {
		in.RunMode = "manual"
	}
	in.Cursor = strings.TrimSpace(in.Cursor)
	for i := range in.Contacts {
		in.Contacts[i].SourceID = strings.TrimSpace(in.Contacts[i].SourceID)
		in.Contacts[i].Email = strings.ToLower(strings.TrimSpace(in.Contacts[i].Email))
		in.Contacts[i].FirstName = strings.TrimSpace(in.Contacts[i].FirstName)
		in.Contacts[i].LastName = strings.TrimSpace(in.Contacts[i].LastName)
		in.Contacts[i].FullName = strings.TrimSpace(in.Contacts[i].FullName)
		in.Contacts[i].Phone = strings.TrimSpace(in.Contacts[i].Phone)
		in.Contacts[i].Company = strings.TrimSpace(in.Contacts[i].Company)
		in.Contacts[i].LifecycleStage = strings.TrimSpace(in.Contacts[i].LifecycleStage)
	}
	for i := range in.Events {
		in.Events[i].SourceID = strings.TrimSpace(in.Events[i].SourceID)
		in.Events[i].Email = strings.ToLower(strings.TrimSpace(in.Events[i].Email))
		in.Events[i].Phone = strings.TrimSpace(in.Events[i].Phone)
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
		"client_secret",
		"consumer_secret",
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
