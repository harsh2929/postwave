// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

const (
	supportSyncModelIngest                = "postwave_support_ingest"
	zendeskSyncModelNative                = "zendesk_tickets_rest_sideload_users"
	intercomSyncModelNative               = "intercom_conversations_rest_contact_lookup_signed_webhooks"
	helpScoutSyncModelNative              = "helpscout_conversations_threads_signed_webhooks_mailbox"
	gorgiasSyncModelNative                = "gorgias_tickets_rest_embedded_customer_commerce_evidence"
	freshdeskSyncModelNative              = "freshdesk_tickets_rest_requester_product_filter_authenticated_webhooks"
	freshchatSyncModelNative              = "freshchat_users_conversations_messages_rest_signed_webhooks_backfill"
	tidioSyncModelNative                  = "tidio_openapi_tickets_contacts_messages_signed_webhooks_backfill"
	adaSyncModelNative                    = "ada_data_export_conversations_messages_svix_webhooks_backfill"
	gladlySyncModelNative                 = "gladly_customer_conversations_items_events_authenticated_webhooks_backfill"
	grooveSyncModelNative                 = "groove_tickets_messages_rest_route_token_webhooks_backfill"
	helpCrunchSyncModelNative             = "helpcrunch_chats_messages_rest_signed_webhooks_backfill"
	jiraServiceManagementSyncModelNative  = "jira_service_management_requests_comments_route_token_webhooks_backfill"
	linearSyncModelNative                 = "linear_graphql_issues_comments_signed_webhooks_backfill"
	asanaSupportSyncModelNative           = "asana_tasks_stories_rest_signed_webhooks_backfill"
	clickUpSupportSyncModelNative         = "clickup_tasks_comments_rest_signed_webhooks_backfill"
	frontSyncModelNative                  = "front_inbox_conversations_rest_contacts_signed_webhooks_backfill"
	reamazeSyncModelNative                = "reamaze_conversations_messages_rest_contacts_backfill"
	crispSyncModelNative                  = "crisp_conversations_rest_people_signed_webhooks_backfill"
	kustomerSyncModelNative               = "kustomer_conversations_rest_customer_lookup_signed_webhooks_backfill"
	driftSyncModelNative                  = "drift_conversations_rest_contact_lookup_authenticated_webhooks_backfill"
	liveChatSyncModelNative               = "livechat_archives_group_rest_customer_payload_secret_webhooks_managed_registration_cleanup_backfill"
	zohoDeskSyncModelNative               = "zoho_desk_tickets_threads_department_rest_contacts_jwt_webhooks_backfill"
	olarkSyncModelNative                  = "olark_transcripts_messages_rest_visitors_route_token_webhooks_backfill"
	kayakoSyncModelNative                 = "kayako_cases_posts_requester_resources_route_token_webhooks_backfill"
	hubSpotSyncModelNative                = "hubspot_service_hub_tickets_pipeline_rest_contact_lookup_signed_webhooks_backfill"
	salesforceServiceCloudSyncModelNative = "salesforce_service_cloud_cases_case_comments_queues_soql_contact_email_cdc_relay_backfill"
)

func managedSupportProviderSpec(provider, name, authMode string, required, optional []ProviderField, scopes, syncObjects, webhookTopics []string) ProviderSpec {
	requiredSettings := append([]ProviderField(nil), required...)
	requiredSettings = append(requiredSettings, ProviderField{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing " + name + " API or OAuth credentials"})
	optionalSettings := append([]ProviderField(nil), optional...)
	optionalSettings = append(optionalSettings,
		ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for " + name + " webhook verification"},
		ProviderField{Key: "default_tags", Label: "Default tags", Help: "Comma-separated tags applied to imported support profiles"},
	)
	return ProviderSpec{
		Provider:         provider,
		Name:             name,
		Category:         "customer_service",
		AuthMode:         authMode,
		Managed:          true,
		RuntimeStatus:    "partial",
		Capabilities:     []string{"profiles", "events", "support", "automation_triggers"},
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
		Provider:      ProviderZendesk,
		Name:          "Zendesk",
		Category:      "customer_service",
		AuthMode:      "oauth_or_api_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "subdomain", Label: "Zendesk subdomain", Required: true, Help: "The subdomain in acme.zendesk.com"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing OAuth or API-token credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Zendesk webhook verification"},
			{Key: "zendesk_webhook_id", Label: "Zendesk webhook ID", Help: "Optional Zendesk webhook id used to constrain signed public webhook routing"},
			{Key: "brand_id", Label: "Brand ID", Help: "Optional Zendesk brand filter"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Zendesk API host override for test or regional routing"},
			{Key: "page_size", Label: "Page size", Help: "Tickets per API page; capped at Zendesk's 100 item cursor page size"},
			{Key: "incremental_export_enabled", Label: "Use Incremental Export", Help: "Opt into Zendesk Incremental Export cursor pulls instead of the Tickets list cursor"},
			{Key: "incremental_start_time", Label: "Incremental start time", Help: "Initial Incremental Export start time as Unix seconds or RFC3339"},
			{Key: "incremental_page_size", Label: "Incremental page size", Help: "Tickets per Incremental Export page; capped at Zendesk's 1000 item limit"},
		},
		Scopes:        []string{"tickets:read", "users:read", "organizations:read", "webhooks:write"},
		SyncObjects:   []string{"tickets", "comments", "users", "organizations", "webhooks"},
		WebhookTopics: []string{"ticket.created", "ticket.updated", "comment.created"},
		DocsURL:       "/docs/integrations/zendesk",
	},
	{
		Provider:      ProviderIntercom,
		Name:          "Intercom",
		Category:      "customer_service",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Intercom workspace identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Intercom OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Intercom webhook verification"},
			{Key: "inbox_id", Label: "Inbox ID", Help: "Optional inbox filter"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Intercom API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Conversations per API page; capped at Intercom's 150 item cursor page size"},
		},
		Scopes:        []string{"conversations.read", "contacts.read", "admins.read", "webhooks.write"},
		SyncObjects:   []string{"conversations", "conversation_parts", "contacts", "admins", "webhooks"},
		WebhookTopics: []string{"conversation.user.created", "conversation.admin.replied", "conversation.admin.closed"},
		DocsURL:       "/docs/integrations/intercom",
	},
	{
		Provider:      ProviderGorgias,
		Name:          "Gorgias",
		Category:      "customer_service",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "commerce", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Gorgias account domain or subdomain"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Gorgias API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Gorgias webhook verification"},
			{Key: "gorgias_http_integration_id", Label: "Gorgias HTTP integration ID", Help: "Optional Gorgias HTTP integration id used to constrain authenticated callback routing"},
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional Shopify domain label for commerce evidence and future order resolution"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Gorgias API host override for test or regional routing"},
			{Key: "page_size", Label: "Page size", Help: "Tickets per API page; capped at Gorgias' 100 item limit"},
		},
		Scopes:        []string{"tickets:read", "customers:read", "messages:read", "webhooks:write"},
		SyncObjects:   []string{"tickets", "messages", "customers", "macros", "webhooks"},
		WebhookTopics: []string{"ticket-created", "ticket-message-created", "ticket-updated"},
		DocsURL:       "/docs/integrations/gorgias",
	},
	{
		Provider:      ProviderFreshdesk,
		Name:          "Freshdesk",
		Category:      "customer_service",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Freshdesk account domain, for example acme.freshdesk.com"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Freshdesk API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Freshdesk webhook verification"},
			{Key: "product_id", Label: "Product ID", Help: "Optional Freshdesk product filter for multi-product desks"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Freshdesk API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Tickets per API page; capped at Freshdesk's 100 item page size"},
		},
		Scopes:        []string{},
		SyncObjects:   []string{"tickets", "conversations", "contacts", "companies", "agents", "webhooks"},
		WebhookTopics: []string{"ticket.create", "ticket.update", "conversation.create"},
		DocsURL:       "/docs/integrations/freshdesk",
	},
	{
		Provider:      ProviderHelpScout,
		Name:          "Help Scout",
		Category:      "customer_service",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "mailbox_id", Label: "Mailbox ID", Required: true, Help: "Help Scout mailbox identifier to sync"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Help Scout OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Help Scout webhook verification"},
			{Key: "help_scout_webhook_id", Label: "Help Scout webhook ID", Help: "Optional Help Scout webhook id used to constrain signed public webhook routing"},
			{Key: "team_id", Label: "Team ID", Help: "Optional Help Scout team filter"},
			{Key: "status", Label: "Status", Help: "Optional Help Scout conversation status filter; defaults to all"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Help Scout API host override for test routing"},
		},
		Scopes:        []string{"conversations.read", "customers.read", "mailboxes.read", "webhooks.write"},
		SyncObjects:   []string{"conversations", "threads", "customers", "mailboxes", "teams", "webhooks"},
		WebhookTopics: []string{"convo.created", "convo.status", "customer.created"},
		DocsURL:       "/docs/integrations/help-scout",
	},
	{
		Provider:      ProviderFront,
		Name:          "Front",
		Category:      "customer_service",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "inbox_id", Label: "Inbox ID", Required: true, Help: "Front inbox identifier to sync"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Front API or OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "front_webhook_secret_ref", Label: "Front webhook secret reference", Help: "Vault reference for Front application or rule webhook signature verification"},
			{Key: "front_webhook_id", Label: "Front webhook ID", Help: "Optional Front webhook id used to constrain signed public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Front API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Conversations per API page; capped at Front's 100 item page size"},
			{Key: "teammate_id", Label: "Teammate ID", Help: "Optional teammate filter"},
		},
		Scopes:        []string{"conversations:read", "contacts:read", "inboxes:read", "webhooks:write"},
		SyncObjects:   []string{"conversations", "messages", "contacts", "inboxes", "teammates", "webhooks"},
		WebhookTopics: []string{"inbound", "outbound", "comment", "archive"},
		DocsURL:       "/docs/integrations/front",
	},
	{
		Provider:      ProviderZohoDesk,
		Name:          "Zoho Desk",
		Category:      "customer_service",
		AuthMode:      "oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "support", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "organization_id", Label: "Organization ID", Required: true, Help: "Zoho Desk organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Zoho Desk OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "department_id", Label: "Department ID", Help: "Optional Zoho Desk department filter"},
			{Key: "data_center", Label: "Data center", Help: "Optional Zoho data center, for example us, eu, in, au, or jp"},
			{Key: "notification_token_ref", Label: "Notification token reference", Help: "Vault reference for Zoho Desk webhook or notification callback token"},
		},
		Scopes:        []string{"Desk.tickets.READ", "Desk.contacts.READ", "Desk.basic.READ", "Desk.events.CREATE"},
		SyncObjects:   []string{"tickets", "threads", "contacts", "accounts", "departments", "agents", "webhooks"},
		WebhookTopics: []string{"ticket.add", "ticket.update", "thread.add"},
		DocsURL:       "/docs/integrations/zoho-desk",
	},
	managedSupportProviderSpec(
		ProviderKustomer,
		"Kustomer",
		"api_key_ref",
		[]ProviderField{
			{Key: "organization_id", Label: "Organization ID", Required: true, Help: "Kustomer organization identifier"},
		},
		[]ProviderField{
			{Key: "kustomer_webhook_secret_ref", Label: "Kustomer webhook secret reference", Help: "Vault reference for Kustomer outbound webhook signature verification"},
			{Key: "kustomer_webhook_id", Label: "Kustomer webhook ID", Help: "Optional Kustomer webhook id used to constrain signed public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Kustomer API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Conversations per API page; capped at Kustomer's 100 item page size"},
		},
		[]string{"customers.read", "conversations.read", "messages.read", "webhooks.write"},
		[]string{"customers", "conversations", "messages", "queues", "teams", "webhooks"},
		[]string{"conversation.created", "conversation.updated", "message.created"},
	),
	managedSupportProviderSpec(
		ProviderFreshchat,
		"Freshchat",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Freshchat account domain or Freshworks workspace domain"},
		},
		[]ProviderField{
			{Key: "channel_id", Label: "Channel ID", Help: "Optional Freshchat channel filter"},
		},
		[]string{"conversations.read", "users.read", "channels.read", "webhooks.write"},
		[]string{"conversations", "messages", "users", "channels", "agents", "webhooks"},
		[]string{"conversation.created", "message.created", "conversation.resolved"},
	),
	managedSupportProviderSpec(
		ProviderLiveChat,
		"LiveChat",
		"oauth_ref",
		[]ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "LiveChat account identifier"},
		},
		[]ProviderField{
			{Key: "group_id", Label: "Group ID", Help: "Optional LiveChat group filter"},
			{Key: "livechat_manage_webhook", Label: "Manage webhook", Help: "Set true to let Moosewave register LiveChat webhooks through the Configuration API"},
			{Key: "livechat_owner_client_id", Label: "Owner client ID", Help: "LiveChat owner_client_id required for managed webhook cleanup"},
			{Key: "livechat_webhook_actions", Label: "Webhook actions", Help: "Optional comma-separated managed webhook actions; defaults to incoming_chat,incoming_event"},
			{Key: "livechat_webhook_secret_ref", Label: "LiveChat webhook secret reference", Help: "Vault reference for LiveChat webhook secret_key verification"},
			{Key: "livechat_webhook_id", Label: "LiveChat webhook ID", Help: "Optional LiveChat webhook id used to constrain public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional LiveChat API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Archive chats per API page; capped at LiveChat's 100 item page size"},
		},
		[]string{"chats.read", "customers.read", "agents.read", "webhooks.write"},
		[]string{"chats", "threads", "events", "customers", "agents", "webhooks"},
		[]string{"chat_started", "chat_ended", "incoming_event"},
	),
	managedSupportProviderSpec(
		ProviderCrisp,
		"Crisp",
		"api_key_ref",
		[]ProviderField{
			{Key: "website_id", Label: "Website ID", Required: true, Help: "Crisp website identifier"},
		},
		[]ProviderField{
			{Key: "crisp_webhook_secret_ref", Label: "Crisp webhook secret reference", Help: "Vault reference for Crisp plugin-hook signature verification"},
			{Key: "crisp_webhook_id", Label: "Crisp webhook ID", Help: "Optional Crisp plugin-hook id used to constrain signed public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Crisp API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Conversations per API page; capped at Crisp's 50 item page size"},
			{Key: "tier", Label: "API tier", Help: "Optional Crisp API tier header override; defaults to plugin"},
		},
		[]string{"website:conversations:read", "website:people:read", "website:webhooks:write"},
		[]string{"websites", "conversations", "messages", "people", "operators", "webhooks"},
		[]string{"message:send", "session:set_email", "session:set_state"},
	),
	managedSupportProviderSpec(
		ProviderTidio,
		"Tidio",
		"api_key_ref",
		[]ProviderField{
			{Key: "project_id", Label: "Project ID", Required: true, Help: "Tidio project identifier"},
		},
		[]ProviderField{
			{Key: "project_public_key", Label: "Project public key", Help: "Tidio project_public_key used by signed webhook routing"},
			{Key: "tidio_webhook_secret_ref", Label: "Tidio webhook secret reference", Help: "Vault reference for Tidio x-tidio-signature verification"},
			{Key: "tidio_webhook_id", Label: "Tidio webhook ID", Help: "Optional Tidio webhook id used to constrain signed public webhook routing"},
			{Key: "channel_id", Label: "Channel ID", Help: "Optional channel filter for chat conversations"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Tidio OpenAPI host override for test routing"},
		},
		[]string{"contacts.read", "tickets.read", "operators.read", "webhooks.write"},
		[]string{"contacts", "contact_messages", "tickets", "ticket_messages", "operators", "channels", "webhooks"},
		[]string{"contact.created", "contact.updated", "conversation.operator_replied", "ticket.created", "ticket.status_updated", "ticket.replied", "ticket.operator_assigned", "customer_satisfaction.rated"},
	),
	managedSupportProviderSpec(
		ProviderOlark,
		"Olark",
		"api_key_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Olark site identifier"},
		},
		nil,
		[]string{"transcripts.read", "visitors.read", "operators.read", "webhooks.write"},
		[]string{"transcripts", "messages", "visitors", "operators", "groups", "webhooks"},
		[]string{"chat.started", "chat.ended", "transcript.created"},
	),
	managedSupportProviderSpec(
		ProviderDrift,
		"Drift",
		"oauth_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Drift workspace identifier"},
		},
		[]ProviderField{
			{Key: "drift_webhook_secret_ref", Label: "Drift webhook verification token reference", Help: "Vault reference for Drift webhook verification-token checks"},
			{Key: "drift_webhook_id", Label: "Drift webhook ID", Help: "Optional Drift webhook id used to constrain public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Drift API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Conversations per API page; capped at Drift's 50 item page size"},
		},
		[]string{"conversations_read", "contacts_read", "users_read", "webhooks_write"},
		[]string{"conversations", "messages", "contacts", "users", "inboxes", "webhooks"},
		[]string{"conversation_created", "message_created", "conversation_closed"},
	),
	managedSupportProviderSpec(
		ProviderAda,
		"Ada",
		"api_key_ref",
		[]ProviderField{
			{Key: "ai_agent_domain", Label: "AI Agent domain", Required: true, Help: "Ada AI Agent domain, for example example.ada.support"},
		},
		[]ProviderField{
			{Key: "bot_id", Label: "Bot ID / legacy domain", Help: "Compatibility alias for Ada AI Agent domain on older installs"},
			{Key: "language", Label: "Language", Help: "Optional language filter for conversations"},
			{Key: "handoff_integration", Label: "Handoff integration", Help: "Optional Ada handoff integration filter"},
		},
		[]string{"data_export.read", "conversations.read", "end_users.read", "webhooks.write"},
		[]string{"export_conversations", "export_messages", "conversation_messages", "end_users", "webhooks"},
		[]string{"v1.conversation.created", "v1.conversation.message", "v1.conversation.ended", "v1.conversation.handoff.ended", "v1.end_user.created", "v1.end_user.updated"},
	),
	managedSupportProviderSpec(
		ProviderGladly,
		"Gladly",
		"api_key_ref",
		[]ProviderField{
			{Key: "organization_domain", Label: "Organization domain", Required: true, Help: "Gladly organization domain, for example acme.gladly.com"},
		},
		[]ProviderField{
			{Key: "organization_id", Label: "Organization ID / subdomain", Help: "Compatibility alias for the Gladly organization domain"},
			{Key: "customer_ids", Label: "Customer IDs", Help: "Optional comma-separated customer IDs for deterministic customer-scoped backfill"},
			{Key: "event_entities", Label: "Event entities", Help: "Optional Gladly event entity filter for recent event polling"},
		},
		[]string{"customers.read", "conversations.read", "tasks.read", "webhooks.write"},
		[]string{"customer_profiles", "customer_conversations", "conversation_items", "tasks", "events", "webhooks"},
		[]string{"CONVERSATION", "CUSTOMER_PROFILE", "TASK", "PING"},
	),
	managedSupportProviderSpec(
		ProviderReamaze,
		"Reamaze",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Reamaze account domain or brand subdomain"},
		},
		[]ProviderField{
			{Key: "reamaze_webhook_id", Label: "Webhook route token", Help: "Opaque Moosewave route token embedded in the Reamaze callback URL"},
		},
		[]string{"conversations.read", "contacts.read", "channels.read", "webhooks.write"},
		[]string{"conversations", "messages", "contacts", "channels", "brands", "webhooks"},
		[]string{"conversation.created", "conversation.updated", "message.created"},
	),
	managedSupportProviderSpec(
		ProviderGroove,
		"Groove",
		"api_key_ref",
		[]ProviderField{
			{Key: "mailbox_id", Label: "Mailbox ID", Required: true, Help: "Groove mailbox identifier"},
		},
		[]ProviderField{
			{Key: "folder_id", Label: "Folder ID", Help: "Optional Groove folder filter for ticket pulls"},
			{Key: "state", Label: "State", Help: "Optional Groove ticket state filter"},
		},
		[]string{"tickets.read", "customers.read", "mailboxes.read", "webhooks.write"},
		[]string{"tickets", "conversations", "messages", "customers", "mailboxes", "webhooks"},
		[]string{"ticket.created", "ticket.updated", "message.created"},
	),
	managedSupportProviderSpec(
		ProviderKayako,
		"Kayako",
		"api_key_ref",
		[]ProviderField{
			{Key: "account_domain", Label: "Account domain", Required: true, Help: "Kayako account domain"},
		},
		nil,
		[]string{"cases.read", "conversations.read", "users.read", "webhooks.write"},
		[]string{"cases", "conversations", "messages", "users", "organizations", "webhooks"},
		[]string{"case.created", "case.updated", "conversation.message.created"},
	),
	managedSupportProviderSpec(
		ProviderHelpCrunch,
		"HelpCrunch",
		"api_key_ref",
		[]ProviderField{
			{Key: "organization_id", Label: "Organization ID", Required: true, Help: "HelpCrunch organization identifier"},
		},
		[]ProviderField{
			{Key: "widget_id", Label: "Widget ID", Help: "Optional widget filter for chat conversations"},
		},
		[]string{"chats.read", "customers.read", "agents.read", "webhooks.write"},
		[]string{"chats", "messages", "customers", "agents", "widgets", "webhooks"},
		[]string{"chat.created", "message.created", "chat.closed"},
	),
	managedSupportProviderSpec(
		ProviderHubSpotServiceHub,
		"HubSpot Service Hub",
		"oauth_ref",
		[]ProviderField{
			{Key: "portal_id", Label: "Portal ID", Required: true, Help: "HubSpot portal identifier"},
		},
		[]ProviderField{
			{Key: "pipeline_id", Label: "Pipeline ID", Help: "Optional ticket pipeline filter"},
			{Key: "hubspot_service_hub_webhook_secret_ref", Label: "HubSpot webhook client secret reference", Help: "Vault reference for HubSpot app client secret used by v3 webhook signature verification"},
			{Key: "hubspot_webhook_id", Label: "HubSpot webhook ID", Help: "Optional HubSpot app webhook id used to constrain public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional HubSpot API host override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Tickets per API page; capped at HubSpot's 100 item page size"},
		},
		[]string{"tickets", "crm.objects.contacts.read", "conversations.read", "webhooks.write"},
		[]string{"tickets", "conversations", "messages", "contacts", "pipelines", "webhooks"},
		[]string{"ticket.creation", "ticket.propertyChange", "conversation.newMessage"},
	),
	managedSupportProviderSpec(
		ProviderSalesforceServiceCloud,
		"Salesforce Service Cloud",
		"oauth_ref",
		[]ProviderField{
			{Key: "instance_url", Label: "Instance URL", Required: true, Help: "Salesforce instance URL"},
		},
		[]ProviderField{
			{Key: "case_record_type_id", Label: "Case record type ID", Help: "Optional Case record type filter"},
			{Key: "case_queue_id", Label: "Case queue ID", Help: "Optional Salesforce Case owner/queue ID filter"},
			{Key: "salesforce_service_cloud_webhook_secret_ref", Label: "Salesforce CDC relay secret reference", Help: "Vault reference used to authenticate the operator-managed CDC/Pub/Sub relay"},
			{Key: "salesforce_service_cloud_webhook_id", Label: "Salesforce CDC relay ID", Help: "Optional relay id used to constrain public CDC relay routing"},
		},
		[]string{"api", "refresh_token", "cases.read", "contacts.read", "webhooks.write"},
		[]string{"cases", "case_comments", "contacts", "accounts", "queues", "webhooks"},
		[]string{"case.created", "case.updated", "case_comment.created"},
	),
	managedSupportProviderSpec(
		ProviderJiraServiceManagement,
		"Jira Service Management",
		"oauth_ref",
		[]ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Atlassian site or cloud identifier"},
			{Key: "service_desk_id", Label: "Service desk ID", Required: true, Help: "Jira Service Management service desk identifier"},
		},
		[]ProviderField{
			{Key: "project_key", Label: "Project key", Help: "Optional Jira project key filter"},
			{Key: "cloud_id", Label: "Cloud ID", Help: "Atlassian cloudId alias for OAuth API routing"},
			{Key: "site_url", Label: "Site URL", Help: "Optional direct Jira site URL for Connect/API-token routing"},
			{Key: "organization_id", Label: "Organization ID", Help: "Optional JSM organization filter for request pulls"},
			{Key: "request_status", Label: "Request status", Help: "Optional JSM requestStatus filter"},
			{Key: "jira_service_management_webhook_id", Label: "Jira Service Management webhook route token", Help: "Required route token for operator-configured Jira webhook callbacks"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Atlassian API base URL override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Requests per API page; capped at Jira Service Management's 100 item page size"},
			{Key: "default_email", Label: "Default email", Help: "Fallback email for privacy-hidden Jira reporters in controlled support queues"},
		},
		[]string{"read:jira-work", "read:servicedesk-request", "manage:webhook:jira"},
		[]string{"service_desks", "requests", "issues", "comments", "customers", "organizations", "webhooks"},
		[]string{"request.created", "request.updated", "comment.created"},
	),
	managedSupportProviderSpec(
		ProviderLinear,
		"Linear",
		"oauth_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Linear workspace identifier"},
		},
		[]ProviderField{
			{Key: "team_id", Label: "Team ID", Help: "Optional Linear team filter for customer issues"},
			{Key: "linear_webhook_secret_ref", Label: "Linear webhook signing secret reference", Help: "Vault reference for Linear-Signature HMAC-SHA256 verification"},
			{Key: "linear_webhook_id", Label: "Linear webhook ID", Help: "Optional Linear webhook id used to constrain signed public webhook routing"},
			{Key: "graphql_url", Label: "GraphQL URL", Help: "Optional Linear GraphQL endpoint override for test routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Alias for GraphQL URL override"},
			{Key: "page_size", Label: "Page size", Help: "Issues per GraphQL page; capped at 100"},
			{Key: "default_email", Label: "Default email", Help: "Fallback email for support queues where Linear user/customer records do not expose email"},
		},
		[]string{"read", "issues:read", "comments:read", "webhooks:write"},
		[]string{"issues", "comments", "customers", "teams", "projects", "webhooks"},
		[]string{"Issue", "Comment", "CustomerNeed"},
	),
	managedSupportProviderSpec(
		ProviderAsanaSupport,
		"Asana Support",
		"oauth_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "Asana workspace or organization identifier"},
		},
		[]ProviderField{
			{Key: "project_id", Label: "Project ID", Help: "Optional support project filter"},
			{Key: "asana_webhook_secret_ref", Label: "Asana webhook secret reference", Help: "Vault reference for X-Hook-Signature HMAC-SHA256 verification"},
			{Key: "asana_webhook_id", Label: "Asana webhook ID", Help: "Optional Asana webhook id used to constrain signed public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Asana API base URL override for test routing"},
			{Key: "page_size", Label: "Page size", Help: "Tasks per API page; capped at Asana's 100 item page size"},
			{Key: "default_email", Label: "Default email", Help: "Fallback requester email for controlled support projects"},
		},
		[]string{"default", "tasks:read", "stories:read", "webhooks:write"},
		[]string{"tasks", "stories", "projects", "users", "custom_fields", "webhooks"},
		[]string{"task.added", "task.changed", "story.added"},
	),
	managedSupportProviderSpec(
		ProviderClickUpSupport,
		"ClickUp Support",
		"oauth_ref",
		[]ProviderField{
			{Key: "workspace_id", Label: "Workspace ID", Required: true, Help: "ClickUp workspace/team identifier"},
		},
		[]ProviderField{
			{Key: "list_id", Label: "List ID", Help: "Optional support list filter"},
			{Key: "clickup_webhook_secret_ref", Label: "ClickUp webhook secret reference", Help: "Vault reference for X-Signature HMAC-SHA256 verification"},
			{Key: "clickup_webhook_id", Label: "ClickUp webhook ID", Help: "Optional ClickUp webhook id used to constrain signed public webhook routing"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional ClickUp API base URL override for test routing"},
			{Key: "order_by", Label: "Order by", Help: "Optional ClickUp task ordering field, for example updated or created"},
			{Key: "date_updated_gt", Label: "Updated after", Help: "Optional ClickUp updated-after epoch milliseconds filter"},
			{Key: "default_email", Label: "Default email", Help: "Fallback requester email for controlled support lists"},
		},
		[]string{"task.read", "comment.read", "team.read", "webhook.write"},
		[]string{"tasks", "comments", "lists", "spaces", "teams", "webhooks"},
		[]string{"taskCreated", "taskUpdated", "taskCommentPosted"},
	),
}

func ProviderSpecs() []ProviderSpec {
	out := make([]ProviderSpec, 0, len(providerSpecs))
	for _, spec := range providerSpecs {
		out = append(out, supportSpecWithRuntimeDefaults(spec))
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
			return supportSpecWithRuntimeDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

func supportSpecWithRuntimeDefaults(spec ProviderSpec) ProviderSpec {
	if spec.Provider == ProviderZendesk {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "webhook_secret_ref")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"tickets:read", "users:read"}
		spec.SyncObjects = []string{"tickets", "comments", "users", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket.created", "ticket.updated", "comment.created"}
		spec.SyncModel = zendeskSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderIntercom {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderFields(withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "webhook_secret_ref"), "inbox_id")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"conversations.read", "contacts.read"}
		spec.SyncObjects = []string{"conversations", "profiles", "events"}
		spec.WebhookTopics = []string{"conversation.user.created", "conversation.user.replied", "conversation.admin.replied", "conversation.admin.closed"}
		spec.SyncModel = intercomSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderHelpScout {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderFields(withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "webhook_secret_ref"), "team_id")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"conversations.read"}
		spec.SyncObjects = []string{"conversations", "threads", "messages", "profiles", "events"}
		spec.WebhookTopics = []string{"convo.created", "convo.customer.reply.created", "convo.status"}
		spec.SyncModel = helpScoutSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderGorgias {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "webhook_secret_ref")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{}
		spec.SyncObjects = []string{"tickets", "messages", "customers", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket-created", "ticket-updated", "ticket-message-created"}
		spec.SyncModel = gorgiasSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderFreshdesk {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = append([]ProviderField(nil), spec.OptionalSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "webhook_secret_ref")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "freshdesk_webhook_id", Label: "Freshdesk webhook ID", Help: "Optional automation/webhook identifier used to constrain authenticated public webhook routing"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{}
		spec.SyncObjects = []string{"tickets", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket.created", "ticket.updated"}
		spec.SyncModel = freshdeskSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderFreshchat {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "channel_id", "freshchat_webhook_public_key_ref", "freshchat_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Freshchat/Freshworks API host override for test routing"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Users per API page; capped at Freshchat's 100 item page size"},
			ProviderField{Key: "freshchat_webhook_public_key_ref", Label: "Freshchat webhook public key reference", Help: "Vault reference containing the Freshchat webhook RSA public key"},
			ProviderField{Key: "freshchat_webhook_id", Label: "Freshchat webhook ID", Help: "Optional route token used to constrain signed public webhook routing"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"freshchat.user.view", "freshchat.conversation.view", "freshchat.conversation.messages.view"}
		spec.SyncObjects = []string{"users", "conversations", "messages", "profiles", "events"}
		spec.WebhookTopics = []string{"message_create", "conversation_assignment", "conversation_resolution", "conversation_reopen"}
		spec.SyncModel = freshchatSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderTidio {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "project_public_key", "tidio_webhook_secret_ref", "tidio_webhook_id", "channel_id", "api_base_url")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Tidio x-tidio-signature verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"contacts.read", "tickets.read", "operators.read"}
		spec.SyncObjects = []string{"contacts", "contact_messages", "tickets", "ticket_messages", "profiles", "events"}
		spec.WebhookTopics = []string{"contact.created", "contact.updated", "conversation.operator_replied", "ticket.created", "ticket.status_updated", "ticket.replied", "ticket.operator_assigned", "customer_satisfaction.rated"}
		spec.SyncModel = tidioSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderAda {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "bot_id", "ada_webhook_secret_ref", "ada_webhook_id", "api_base_url", "page_size", "message_page_size", "created_since", "created_to", "handoff_integration", "channel")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "ada_webhook_secret_ref", Label: "Ada webhook secret reference", Help: "Vault reference for Ada Svix/Webhooks Standard signature verification"},
			ProviderField{Key: "ada_webhook_id", Label: "Ada webhook ID", Help: "Optional Ada webhook endpoint id used to constrain signed public webhook routing"},
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Ada API host override for test routing"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Conversation export page size; clamped to Ada's 100-10000 range"},
			ProviderField{Key: "message_page_size", Label: "Message page size", Help: "Per-conversation message export page size; clamped to Ada's 100-10000 range"},
			ProviderField{Key: "created_since", Label: "Created since", Help: "Optional ISO-8601 UTC Data Export window start"},
			ProviderField{Key: "created_to", Label: "Created to", Help: "Optional ISO-8601 UTC Data Export window end"},
			ProviderField{Key: "channel", Label: "Channel", Help: "Optional Ada channel filter"},
			ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Ada Svix/Webhooks Standard signature verification"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"data_export.read", "conversations.read", "end_users.read", "webhooks.write"}
		spec.SyncObjects = []string{"export_conversations", "export_messages", "conversation_messages", "end_users", "profiles", "events"}
		spec.WebhookTopics = []string{"v1.conversation.created", "v1.conversation.message", "v1.conversation.ended", "v1.conversation.handoff.ended", "v1.end_user.created", "v1.end_user.updated"}
		spec.SyncModel = adaSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderGladly {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "organization_id", "customer_id", "customer_ids", "gladly_customer_id", "gladly_customer_ids", "gladly_webhook_token_ref", "gladly_webhook_secret_ref", "gladly_webhook_id", "api_base_url", "event_entities", "event_window_minutes", "start_at", "end_at", "include_tasks")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "customer_id", Label: "Customer ID", Help: "Optional single Gladly customer ID for deterministic customer-scoped backfill"},
			ProviderField{Key: "gladly_customer_ids", Label: "Gladly customer IDs", Help: "Compatibility alias for comma-separated customer IDs"},
			ProviderField{Key: "gladly_webhook_token_ref", Label: "Gladly webhook token reference", Help: "Vault reference for Gladly Basic/header-token webhook authentication"},
			ProviderField{Key: "gladly_webhook_secret_ref", Label: "Gladly webhook secret reference", Help: "Alternate vault reference for Gladly Basic/header-token webhook authentication"},
			ProviderField{Key: "gladly_webhook_id", Label: "Gladly webhook ID", Help: "Optional Gladly webhook id used to constrain authenticated public webhook routing"},
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Gladly API host override for sandbox/test routing"},
			ProviderField{Key: "event_window_minutes", Label: "Event window minutes", Help: "Recent Gladly Events API polling window; capped at 24 hours"},
			ProviderField{Key: "start_at", Label: "Events start", Help: "Optional ISO-8601 Events API window start"},
			ProviderField{Key: "end_at", Label: "Events end", Help: "Optional ISO-8601 Events API window end"},
			ProviderField{Key: "include_tasks", Label: "Include tasks", Help: "When true, customer-scoped backfill also maps Gladly tasks as support events"},
			ProviderField{Key: "webhook_auth_ref", Label: "Webhook auth reference", Help: "Alternate vault reference for Gladly Basic/header-token webhook authentication"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"API User", "customers.read", "conversations.read", "tasks.read", "events.read", "webhooks.write"}
		spec.SyncObjects = []string{"customer_profiles", "customer_conversations", "conversation_items", "tasks", "events", "profiles"}
		spec.WebhookTopics = []string{"CONVERSATION", "CUSTOMER_PROFILE", "TASK", "PING"}
		spec.SyncModel = gladlySyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderGroove {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderFields(withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "folder_id", "state", "customer", "groove_webhook_id", "api_base_url", "page_size", "message_page_size"), "team_id")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "customer", Label: "Customer", Help: "Optional Groove customer email/id filter for ticket pulls"},
			ProviderField{Key: "groove_webhook_id", Label: "Groove webhook route token", Help: "Required route token for unsigned Groove webhook callback URLs"},
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Groove API host override for test routing"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Tickets per API page; capped to Groove's documented page size range"},
			ProviderField{Key: "message_page_size", Label: "Message page size", Help: "Ticket messages per API page; capped to Groove's documented page size range"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"tickets.read", "customers.read", "mailboxes.read", "webhooks.write"}
		spec.SyncObjects = []string{"tickets", "ticket_messages", "customers", "mailboxes", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket_started", "ticket_opened", "ticket_closed", "ticket_assigned", "ticket_deleted", "agent_replied", "customer_replied"}
		spec.SyncModel = grooveSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderHelpCrunch {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "widget_id", "application_id", "status", "sort", "order", "helpcrunch_webhook_signing_key_ref", "helpcrunch_webhook_secret_ref", "helpcrunch_webhook_id", "webhook_secret_ref", "webhook_signature_ref", "api_base_url", "limit", "page_size", "message_limit", "message_page_size")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "application_id", Label: "Application ID", Help: "Optional HelpCrunch application/widget id filter"},
			ProviderField{Key: "status", Label: "Status", Help: "Optional HelpCrunch chat status filter"},
			ProviderField{Key: "sort", Label: "Sort", Help: "HelpCrunch chat sort field, for example chats.createdAt or lastMessageAt"},
			ProviderField{Key: "order", Label: "Order", Help: "HelpCrunch chat sort direction"},
			ProviderField{Key: "helpcrunch_webhook_signing_key_ref", Label: "HelpCrunch webhook signing key reference", Help: "Vault reference for X-HelpCrunch-Signature HMAC-SHA1 verification"},
			ProviderField{Key: "helpcrunch_webhook_secret_ref", Label: "HelpCrunch webhook secret reference", Help: "Alternate vault reference for X-HelpCrunch-Signature HMAC-SHA1 verification"},
			ProviderField{Key: "helpcrunch_webhook_id", Label: "HelpCrunch webhook ID", Help: "Optional HelpCrunch webhook id used to constrain signed public webhook routing"},
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional HelpCrunch API host override for test routing"},
			ProviderField{Key: "limit", Label: "Limit", Help: "Chats per REST request; capped at HelpCrunch's 100 item limit"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Alias for chats per REST request; capped at HelpCrunch's 100 item limit"},
			ProviderField{Key: "message_limit", Label: "Message limit", Help: "Messages per chat REST request; capped at HelpCrunch's 100 item limit"},
			ProviderField{Key: "message_page_size", Label: "Message page size", Help: "Alias for messages per chat REST request"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"chats.read", "customers.read", "agents.read", "webhooks.write"}
		spec.SyncObjects = []string{"chats", "chat_messages", "customers", "agents", "applications", "profiles", "events"}
		spec.WebhookTopics = []string{"chat.new", "chat.status_updated", "chat.closed", "message.customer", "message.agent", "customer.created", "customer.deleted"}
		spec.SyncModel = helpCrunchSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderJiraServiceManagement {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "project_key", "cloud_id", "site_url", "organization_id", "request_status", "jira_service_management_webhook_id", "api_base_url", "page_size", "default_email")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"read:jira-work", "read:servicedesk-request", "manage:webhook:jira"}
		spec.SyncObjects = []string{"service_desks", "requests", "request_comments", "issues", "customers", "organizations", "profiles", "events"}
		spec.WebhookTopics = []string{"jira:issue_created", "jira:issue_updated", "comment_created", "comment_updated"}
		spec.SyncModel = jiraServiceManagementSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderLinear {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "team_id", "linear_webhook_secret_ref", "linear_webhook_id", "graphql_url", "api_base_url", "page_size", "default_email", "webhook_secret_ref", "webhook_signature_ref")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"read", "issues:read", "comments:read", "customers:read", "webhooks:write"}
		spec.SyncObjects = []string{"issues", "comments", "customers", "customer_needs", "teams", "projects", "profiles", "events"}
		spec.WebhookTopics = []string{"Issue", "Comment", "Customer", "CustomerNeed", "OAuthApp"}
		spec.SyncModel = linearSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderAsanaSupport {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "project_id", "asana_webhook_secret_ref", "asana_webhook_id", "api_base_url", "page_size", "default_email", "webhook_secret_ref", "webhook_signature_ref")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"default", "tasks:read", "stories:read", "webhooks:write"}
		spec.SyncObjects = []string{"tasks", "stories", "projects", "users", "custom_fields", "profiles", "events"}
		spec.WebhookTopics = []string{"task.added", "task.changed", "task.deleted", "story.added"}
		spec.SyncModel = asanaSupportSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderClickUpSupport {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "list_id", "clickup_webhook_secret_ref", "clickup_webhook_id", "api_base_url", "order_by", "date_updated_gt", "default_email", "webhook_secret_ref", "webhook_signature_ref")
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"task.read", "comment.read", "team.read", "webhook.write"}
		spec.SyncObjects = []string{"tasks", "comments", "lists", "spaces", "teams", "profiles", "events"}
		spec.WebhookTopics = []string{"taskCreated", "taskUpdated", "taskDeleted", "taskCommentPosted", "taskCommentUpdated"}
		spec.SyncModel = clickUpSupportSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderFront {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "front_webhook_secret_ref", "front_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Front webhook signature verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"conversations:read", "contacts:read", "inboxes:read"}
		spec.SyncObjects = []string{"conversations", "messages", "contacts", "profiles", "events"}
		spec.WebhookTopics = []string{"inbound", "outbound", "comment", "archive"}
		spec.SyncModel = frontSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderCrisp {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "crisp_webhook_secret_ref", "crisp_webhook_id", "api_base_url", "page_size", "tier")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Crisp plugin-hook signature verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"website:conversations:read", "website:people:read"}
		spec.SyncObjects = []string{"conversations", "messages", "people", "profiles", "events"}
		spec.WebhookTopics = []string{"message:send", "message:received", "session:set_email", "session:set_state", "session:set_subject"}
		spec.SyncModel = crispSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderKustomer {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "kustomer_webhook_secret_ref", "kustomer_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Kustomer outbound webhook signature verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"customers.read", "conversations.read", "messages.read"}
		spec.SyncObjects = []string{"conversations", "messages", "customers", "profiles", "events"}
		spec.WebhookTopics = []string{"conversation.created", "conversation.updated", "message.created"}
		spec.SyncModel = kustomerSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderDrift {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "drift_webhook_secret_ref", "drift_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for Drift webhook verification token"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"conversation_read", "contact_read", "all_contact_read", "user_read", "webhooks.write"}
		spec.SyncObjects = []string{"conversations", "messages", "contacts", "users", "webhooks", "profiles", "events"}
		spec.WebhookTopics = []string{"new_message", "new_command_message", "new_conversation", "conversation_status_updated", "conversation_inactive", "conversation_manual_push", "conversation_push"}
		spec.SyncModel = driftSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderLiveChat {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "livechat_webhook_secret_ref", "livechat_webhook_id", "api_base_url", "page_size", "group_id", "livechat_manage_webhook", "livechat_owner_client_id", "livechat_webhook_actions")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for LiveChat webhook secret_key verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"chats.read", "customers.read", "agents.read"}
		spec.SyncObjects = []string{"chats", "threads", "events", "customers", "profiles"}
		spec.WebhookTopics = []string{"incoming_chat", "incoming_event", "chat_deactivated", "chat_started", "chat_ended"}
		spec.SyncModel = liveChatSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderHubSpotServiceHub {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "hubspot_service_hub_webhook_secret_ref", "hubspot_webhook_id", "api_base_url", "page_size", "pipeline_id")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for HubSpot app client secret used by v3 webhook signature verification"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"tickets", "crm.objects.contacts.read", "webhooks.write"}
		spec.SyncObjects = []string{"tickets", "contacts", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket.creation", "ticket.propertyChange"}
		spec.SyncModel = hubSpotSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderZohoDesk {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "department_id", "data_center", "api_base_url", "page_size", "zoho_desk_webhook_id")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "zoho_desk_webhook_id", Label: "Zoho Desk webhook ID", Help: "Optional Zoho Desk webhook id used to constrain signed public webhook routing"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"Desk.tickets.READ", "Desk.contacts.READ", "Desk.basic.READ"}
		spec.SyncObjects = []string{"tickets", "threads", "contacts", "departments", "profiles", "events"}
		spec.WebhookTopics = []string{"ticket.add", "ticket.update", "thread.add"}
		spec.SyncModel = zohoDeskSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderOlark {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "olark_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Olark API host override for test routing"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Transcripts per API page; capped at Olark's 100 item page size"},
			ProviderField{Key: "olark_webhook_id", Label: "Olark webhook route token", Help: "Required route token for operator-configured Olark webhook callbacks; include it in the webhook URL path or query"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"transcripts.read", "visitors.read", "operators.read"}
		spec.SyncObjects = []string{"transcripts", "messages", "visitors", "profiles", "events"}
		spec.WebhookTopics = []string{"transcript.created"}
		spec.SyncModel = olarkSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderKayako {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "kayako_webhook_id", "api_base_url", "page_size")
		spec.OptionalSettings = append(spec.OptionalSettings,
			ProviderField{Key: "api_base_url", Label: "API base URL", Help: "Optional Kayako API host override for test routing"},
			ProviderField{Key: "page_size", Label: "Page size", Help: "Cases per API page; capped at Kayako's 100 item page size"},
			ProviderField{Key: "kayako_webhook_id", Label: "Kayako webhook route token", Help: "Required route token for operator-configured Kayako webhook callbacks; include it in the webhook URL path or query"},
		)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"cases.read", "conversations.read", "users.read"}
		spec.SyncObjects = []string{"cases", "posts", "users", "profiles", "events"}
		spec.WebhookTopics = []string{"case.created", "case.updated", "conversation.message.created"}
		spec.SyncModel = kayakoSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if spec.Provider == ProviderSalesforceServiceCloud {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFieldsExcept(spec.OptionalSettings, "api_version", "case_record_type_id", "case_queue_id", "salesforce_service_cloud_webhook_secret_ref", "salesforce_service_cloud_webhook_id")
		spec.OptionalSettings = append(spec.OptionalSettings, ProviderField{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Alternate vault reference for the operator-managed Salesforce CDC relay secret"})
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = []string{"api", "refresh_token", "cases.read", "contacts.read"}
		spec.SyncObjects = []string{"cases", "case_comments", "contacts", "queues", "profiles", "events"}
		spec.WebhookTopics = []string{"CaseChangeEvent"}
		spec.SyncModel = salesforceServiceCloudSyncModelNative
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	if isNativeSupportPullerProvider(spec.Provider) {
		spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
		spec.OptionalSettings = withoutSupportProviderRuntimeFields(spec.OptionalSettings)
		spec.Capabilities = append([]string(nil), spec.Capabilities...)
		spec.Scopes = nativeSupportPullerScopes(spec.Provider)
		spec.SyncObjects = nativeSupportPullerObjects(spec.Provider)
		spec.WebhookTopics = []string{}
		spec.SyncModel = nativeSupportPullerSyncModel(spec.Provider)
		spec.VerificationMode = supportVerificationMode(spec.Provider)
		return spec
	}
	spec.RequiredSettings = append([]ProviderField(nil), spec.RequiredSettings...)
	spec.OptionalSettings = withoutSupportProviderRuntimeFields(spec.OptionalSettings)
	spec.Capabilities = append([]string(nil), spec.Capabilities...)
	spec.Scopes = []string{}
	spec.SyncObjects = []string{"tickets", "messages", "events"}
	spec.WebhookTopics = []string{}
	spec.SyncModel = supportSyncModelIngest
	spec.VerificationMode = supportVerificationMode(spec.Provider)
	return spec
}

func isNativeSupportPullerProvider(provider string) bool {
	switch provider {
	case ProviderFront, ProviderReamaze, ProviderCrisp, ProviderKustomer, ProviderDrift,
		ProviderLiveChat, ProviderZohoDesk, ProviderOlark, ProviderKayako, ProviderHubSpotServiceHub,
		ProviderSalesforceServiceCloud, ProviderFreshchat, ProviderTidio, ProviderAda, ProviderGladly, ProviderGroove, ProviderHelpCrunch,
		ProviderJiraServiceManagement, ProviderLinear, ProviderAsanaSupport, ProviderClickUpSupport:
		return true
	default:
		return false
	}
}

func nativeSupportPullerSyncModel(provider string) string {
	switch provider {
	case ProviderFreshchat:
		return freshchatSyncModelNative
	case ProviderTidio:
		return tidioSyncModelNative
	case ProviderAda:
		return adaSyncModelNative
	case ProviderGladly:
		return gladlySyncModelNative
	case ProviderGroove:
		return grooveSyncModelNative
	case ProviderHelpCrunch:
		return helpCrunchSyncModelNative
	case ProviderJiraServiceManagement:
		return jiraServiceManagementSyncModelNative
	case ProviderLinear:
		return linearSyncModelNative
	case ProviderAsanaSupport:
		return asanaSupportSyncModelNative
	case ProviderClickUpSupport:
		return clickUpSupportSyncModelNative
	case ProviderFront:
		return frontSyncModelNative
	case ProviderReamaze:
		return reamazeSyncModelNative
	case ProviderCrisp:
		return crispSyncModelNative
	case ProviderKustomer:
		return kustomerSyncModelNative
	case ProviderDrift:
		return driftSyncModelNative
	case ProviderLiveChat:
		return liveChatSyncModelNative
	case ProviderZohoDesk:
		return zohoDeskSyncModelNative
	case ProviderOlark:
		return olarkSyncModelNative
	case ProviderKayako:
		return kayakoSyncModelNative
	case ProviderHubSpotServiceHub:
		return hubSpotSyncModelNative
	case ProviderSalesforceServiceCloud:
		return salesforceServiceCloudSyncModelNative
	default:
		return supportSyncModelIngest
	}
}

func nativeSupportPullerScopes(provider string) []string {
	switch provider {
	case ProviderFreshchat:
		return []string{"freshchat.user.view", "freshchat.conversation.view", "freshchat.conversation.messages.view"}
	case ProviderTidio:
		return []string{"contacts.read", "tickets.read", "operators.read"}
	case ProviderAda:
		return []string{"data_export.read", "conversations.read", "end_users.read", "webhooks.write"}
	case ProviderGladly:
		return []string{"API User", "customers.read", "conversations.read", "tasks.read", "events.read", "webhooks.write"}
	case ProviderGroove:
		return []string{"tickets.read", "customers.read", "mailboxes.read", "webhooks.write"}
	case ProviderHelpCrunch:
		return []string{"chats.read", "customers.read", "agents.read", "webhooks.write"}
	case ProviderJiraServiceManagement:
		return []string{"read:jira-work", "read:servicedesk-request", "manage:webhook:jira"}
	case ProviderLinear:
		return []string{"read", "issues:read", "comments:read", "customers:read", "webhooks:write"}
	case ProviderAsanaSupport:
		return []string{"default", "tasks:read", "stories:read", "webhooks:write"}
	case ProviderClickUpSupport:
		return []string{"task.read", "comment.read", "team.read", "webhook.write"}
	case ProviderFront:
		return []string{"conversations:read", "contacts:read", "inboxes:read"}
	case ProviderReamaze:
		return []string{"conversations.read", "contacts.read", "channels.read"}
	case ProviderCrisp:
		return []string{"website:conversations:read", "website:people:read"}
	case ProviderKustomer:
		return []string{"customers.read", "conversations.read", "messages.read"}
	case ProviderDrift:
		return []string{"conversations_read", "contacts_read", "users_read"}
	case ProviderLiveChat:
		return []string{"chats.read", "customers.read", "agents.read"}
	case ProviderZohoDesk:
		return []string{"Desk.tickets.READ", "Desk.contacts.READ", "Desk.basic.READ"}
	case ProviderOlark:
		return []string{"transcripts.read", "visitors.read", "operators.read"}
	case ProviderKayako:
		return []string{"cases.read", "conversations.read", "users.read"}
	case ProviderHubSpotServiceHub:
		return []string{"tickets", "crm.objects.contacts.read", "conversations.read"}
	case ProviderSalesforceServiceCloud:
		return []string{"api", "refresh_token", "offline_access"}
	default:
		return []string{}
	}
}

func nativeSupportPullerObjects(provider string) []string {
	switch provider {
	case ProviderFreshchat:
		return []string{"users", "conversations", "messages", "profiles", "events"}
	case ProviderTidio:
		return []string{"contacts", "contact_messages", "tickets", "ticket_messages", "profiles", "events"}
	case ProviderAda:
		return []string{"export_conversations", "export_messages", "conversation_messages", "end_users", "profiles", "events"}
	case ProviderGladly:
		return []string{"customer_profiles", "customer_conversations", "conversation_items", "tasks", "events", "profiles"}
	case ProviderGroove:
		return []string{"tickets", "ticket_messages", "customers", "mailboxes", "profiles", "events"}
	case ProviderHelpCrunch:
		return []string{"chats", "chat_messages", "customers", "agents", "applications", "profiles", "events"}
	case ProviderJiraServiceManagement:
		return []string{"service_desks", "requests", "request_comments", "issues", "customers", "organizations", "profiles", "events"}
	case ProviderLinear:
		return []string{"issues", "comments", "customers", "customer_needs", "teams", "projects", "profiles", "events"}
	case ProviderAsanaSupport:
		return []string{"tasks", "stories", "projects", "users", "custom_fields", "profiles", "events"}
	case ProviderClickUpSupport:
		return []string{"tasks", "comments", "lists", "spaces", "teams", "profiles", "events"}
	case ProviderFront:
		return []string{"conversations", "messages", "contacts", "profiles", "events"}
	case ProviderReamaze:
		return []string{"conversations", "messages", "contacts", "profiles", "events"}
	case ProviderCrisp:
		return []string{"conversations", "messages", "people", "profiles", "events"}
	case ProviderKustomer:
		return []string{"conversations", "messages", "customers", "profiles", "events"}
	case ProviderDrift:
		return []string{"conversations", "messages", "contacts", "profiles", "events"}
	case ProviderLiveChat:
		return []string{"chats", "threads", "customers", "profiles", "events"}
	case ProviderZohoDesk:
		return []string{"tickets", "threads", "contacts", "profiles", "events"}
	case ProviderOlark:
		return []string{"transcripts", "messages", "visitors", "profiles", "events"}
	case ProviderKayako:
		return []string{"cases", "conversations", "users", "profiles", "events"}
	case ProviderHubSpotServiceHub:
		return []string{"tickets", "conversations", "contacts", "profiles", "events"}
	case ProviderSalesforceServiceCloud:
		return []string{"cases", "case_comments", "contacts", "queues", "profiles", "events"}
	default:
		return []string{"tickets", "messages", "events"}
	}
}

func supportVerificationMode(provider string) string {
	switch provider {
	case ProviderZendesk:
		return "zendesk_oauth_or_api_token_tickets_rest_incremental_export_signed_webhooks_pending_live_certification"
	case ProviderIntercom:
		return "intercom_oauth_conversations_rest_contact_lookup_signed_webhooks_pending_cleanup_live_certification"
	case ProviderGorgias:
		return "gorgias_api_key_tickets_rest_cursor_authenticated_http_callbacks_pending_hmac_live_certification"
	case ProviderFreshdesk:
		return "freshdesk_api_key_tickets_rest_requester_product_filter_authenticated_webhooks_pending_cleanup_live_certification"
	case ProviderFreshchat:
		return "freshchat_bearer_users_conversations_messages_rest_signed_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderTidio:
		return "tidio_openapi_contacts_tickets_messages_signed_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderAda:
		return "ada_data_export_conversations_messages_svix_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderGladly:
		return "gladly_basic_auth_customer_conversations_items_events_authenticated_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderGroove:
		return "groove_bearer_tickets_messages_rest_route_token_webhooks_pending_signed_callbacks_managed_registration_cleanup_live_certification"
	case ProviderHelpCrunch:
		return "helpcrunch_bearer_chats_messages_rest_hmac_sha1_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderJiraServiceManagement:
		return "jira_service_management_oauth_requests_comments_rest_route_token_webhooks_pending_oauth_jwt_webhook_managed_refresh_cleanup_live_certification"
	case ProviderLinear:
		return "linear_graphql_issues_comments_customers_hmac_sha256_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderAsanaSupport:
		return "asana_tasks_stories_rest_hmac_sha256_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderClickUpSupport:
		return "clickup_tasks_comments_rest_hmac_sha256_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderHelpScout:
		return "helpscout_oauth_conversations_threads_signed_webhooks_pending_cleanup_live_certification"
	case ProviderFront:
		return "front_bearer_conversations_rest_cursor_signed_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderReamaze:
		return "reamaze_basic_auth_conversations_messages_rest_route_token_webhooks_pending_signed_callbacks_managed_registration_cleanup_live_certification"
	case ProviderCrisp:
		return "crisp_plugin_token_conversations_rest_people_signed_plugin_hooks_pending_managed_registration_cleanup_live_certification"
	case ProviderKustomer:
		return "kustomer_bearer_conversations_rest_customer_lookup_signed_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderDrift:
		return "drift_oauth_conversations_rest_contact_lookup_verification_token_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderLiveChat:
		return "livechat_bearer_archives_rest_customer_payload_secret_webhooks_managed_registration_cleanup_pending_live_certification"
	case ProviderZohoDesk:
		return "zoho_desk_oauth_tickets_threads_rest_contacts_jwt_webhooks_pending_managed_notification_cleanup_live_certification"
	case ProviderOlark:
		return "olark_bearer_transcripts_messages_rest_visitor_route_token_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderKayako:
		return "kayako_basic_auth_cases_posts_rest_requester_resource_route_token_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderHubSpotServiceHub:
		return "hubspot_service_hub_oauth_tickets_rest_contact_lookup_signed_webhooks_pending_managed_registration_cleanup_live_certification"
	case ProviderSalesforceServiceCloud:
		return "salesforce_service_cloud_oauth_cases_case_comments_queues_soql_contact_email_cdc_relay_pending_managed_subscription_cleanup_live_certification"
	default:
		return "postwave_support_ingest_pending_provider_adapter"
	}
}

func withoutSupportProviderRuntimeFields(fields []ProviderField) []ProviderField {
	return withoutSupportProviderRuntimeFieldsExcept(fields)
}

func withoutSupportProviderFields(fields []ProviderField, removeKeys ...string) []ProviderField {
	remove := map[string]bool{}
	for _, key := range removeKeys {
		remove[strings.ToLower(strings.TrimSpace(key))] = true
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

func withoutSupportProviderRuntimeFieldsExcept(fields []ProviderField, keep ...string) []ProviderField {
	keepSet := map[string]bool{}
	for _, key := range keep {
		keepSet[strings.ToLower(strings.TrimSpace(key))] = true
	}
	remove := map[string]bool{
		"notification_channel_id":    true,
		"notification_token_ref":     true,
		"webhook_auth_ref":           true,
		"webhook_secret_ref":         true,
		"webhook_signature_ref":      true,
		"zendesk_webhook_secret_ref": true,
	}
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		key := strings.ToLower(strings.TrimSpace(field.Key))
		if remove[key] && !keepSet[key] {
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
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported support provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	delete(settings, "provider_cleanup")
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if spec.SyncModel == supportSyncModelIngest {
		stripSupportProviderRuntimeSettings(settings)
	} else {
		stripUndeclaredSupportProviderRuntimeSettings(settings, spec)
	}
	if spec.Provider == ProviderIntercom {
		delete(settings, "inbox_id")
	}
	if spec.Provider == ProviderHelpScout {
		delete(settings, "team_id")
	}
	switch spec.Provider {
	case ProviderCrisp:
		delete(settings, "operator_id")
	case ProviderKustomer:
		delete(settings, "team_id")
	case ProviderDrift:
		delete(settings, "inbox_id")
	case ProviderGroove:
		delete(settings, "team_id")
	case ProviderLiveChat:
		delete(settings, "livechat_provider_webhook_id")
		delete(settings, "livechat_provider_webhook_ids")
		delete(settings, "livechat_registered_webhook_id")
		delete(settings, "livechat_webhook_managed_by_postwave")
	case ProviderOlark:
		delete(settings, "group_id")
	case ProviderReamaze, ProviderKayako:
		delete(settings, "brand_id")
	}
	if spec.Provider == ProviderFreshdesk {
		productID := settingString(settings, "product_id")
		if productID != "" {
			n, err := strconv.ParseInt(productID, 10, 64)
			if err != nil || n <= 0 {
				return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("product_id must be a positive numeric Freshdesk product id")
			}
			settings["product_id"] = strconv.FormatInt(n, 10)
		}
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
	if err := integration_egress.ValidateSettings(integration_egress.FamilySupport, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "subdomain"),
			settingString(settings, "workspace_id"),
			settingString(settings, "account_domain"),
			settingString(settings, "organization_domain"),
			settingString(settings, "account_id"),
			settingString(settings, "mailbox_id"),
			settingString(settings, "inbox_id"),
			settingString(settings, "organization_id"),
			settingString(settings, "website_id"),
			settingString(settings, "project_id"),
			settingString(settings, "site_id"),
			settingString(settings, "bot_id"),
			settingString(settings, "portal_id"),
			settingString(settings, "instance_url"),
			settingString(settings, "service_desk_id"),
			settingString(settings, "list_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if spec.Provider == ProviderGorgias {
		in.Scopes = []string{}
	} else if spec.SyncModel == supportSyncModelIngest {
		in.Scopes = []string{}
	} else if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["setup_surface"] = "support_integrations"
	settings["egress_policy_version"] = "v1"
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func stripSupportProviderRuntimeSettings(settings map[string]any) {
	for _, key := range supportProviderRuntimeSettingKeys {
		delete(settings, key)
	}
}

var supportProviderRuntimeSettingKeys = []string{
	"notification_channel_id",
	"notification_token_ref",
	"webhook_auth_ref",
	"webhook_secret_ref",
	"webhook_signature_ref",
	"zendesk_webhook_secret_ref",
}

func stripUndeclaredSupportProviderRuntimeSettings(settings map[string]any, spec ProviderSpec) {
	for _, key := range supportProviderRuntimeSettingKeys {
		if supportSpecDeclaresField(spec, key) {
			continue
		}
		delete(settings, key)
	}
}

func supportSpecDeclaresField(spec ProviderSpec, key string) bool {
	needle := strings.ToLower(strings.TrimSpace(key))
	for _, field := range append(append([]ProviderField{}, spec.RequiredSettings...), spec.OptionalSettings...) {
		if strings.ToLower(strings.TrimSpace(field.Key)) == needle {
			return true
		}
	}
	return false
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(in.RunMode))
	if in.RunMode == "" {
		in.RunMode = "manual"
	}
	in.Cursor = strings.TrimSpace(in.Cursor)
	for i := range in.Tickets {
		in.Tickets[i].SourceID = strings.TrimSpace(in.Tickets[i].SourceID)
		in.Tickets[i].ConversationID = strings.TrimSpace(in.Tickets[i].ConversationID)
		in.Tickets[i].Email = strings.ToLower(strings.TrimSpace(in.Tickets[i].Email))
		in.Tickets[i].RequesterName = strings.TrimSpace(in.Tickets[i].RequesterName)
		in.Tickets[i].Subject = strings.TrimSpace(in.Tickets[i].Subject)
		in.Tickets[i].Status = normalizeStatus(in.Tickets[i].Status)
		in.Tickets[i].Priority = normalizePriority(in.Tickets[i].Priority)
		in.Tickets[i].Assignee = strings.TrimSpace(in.Tickets[i].Assignee)
		in.Tickets[i].Tags = cleanStrings(in.Tickets[i].Tags)
	}
	for i := range in.Messages {
		in.Messages[i].SourceID = strings.TrimSpace(in.Messages[i].SourceID)
		in.Messages[i].ConversationID = strings.TrimSpace(in.Messages[i].ConversationID)
		in.Messages[i].Email = strings.ToLower(strings.TrimSpace(in.Messages[i].Email))
		in.Messages[i].RequesterName = strings.TrimSpace(in.Messages[i].RequesterName)
		in.Messages[i].Subject = strings.TrimSpace(in.Messages[i].Subject)
		in.Messages[i].Direction = normalizeDirection(in.Messages[i].Direction)
		in.Messages[i].SenderType = normalizeSenderType(in.Messages[i].SenderType)
		in.Messages[i].Sender = strings.TrimSpace(in.Messages[i].Sender)
	}
	for i := range in.Events {
		in.Events[i].SourceID = strings.TrimSpace(in.Events[i].SourceID)
		in.Events[i].Email = strings.ToLower(strings.TrimSpace(in.Events[i].Email))
		in.Events[i].EventName = strings.TrimSpace(in.Events[i].EventName)
		in.Events[i].ConversationID = strings.TrimSpace(in.Events[i].ConversationID)
		in.Events[i].TicketID = strings.TrimSpace(in.Events[i].TicketID)
		in.Events[i].Status = normalizeStatus(in.Events[i].Status)
	}
	return in
}

func normalizeStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "new", "open":
		return "open"
	case "pending":
		return "pending"
	case "hold", "waiting":
		return "waiting"
	case "solved", "resolved":
		return "resolved"
	case "closed":
		return "closed"
	case "spam":
		return "spam"
	case "archived":
		return "archived"
	default:
		return "open"
	}
}

func normalizePriority(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "normal", "high", "urgent":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "normal"
	}
}

func normalizeDirection(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "outbound", "internal":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "inbound"
	}
}

func normalizeSenderType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "agent", "system", "ai":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "customer"
	}
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

func cleanStrings(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[strings.ToLower(trimmed)] {
			continue
		}
		seen[strings.ToLower(trimmed)] = true
		out = append(out, trimmed)
	}
	return out
}

func firstString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
