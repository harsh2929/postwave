// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"fmt"
)

// Retry policy, synthesized sync history, audit trail and data-delete
// descriptions that accompany a health report.

func retryPolicyFor(item CatalogItem) RetryPolicy {
	switch {
	case isKlaviyoNativeSurface(item):
		return RetryPolicy{Mode: "klaviyo_native_json_api_provider_row_scheduled_signed_webhooks_managed_subscription", MaxAttempts: 3, Backoff: "Klaviyo Retry-After plus scheduled provider-row retry through marketing_sync_runs and klaviyo_native cursors; provider webhook retries dedupe through marketing_webhook_events", DeadLetter: "marketing integration error state, native provider-row source-event monitor error state, failed marketing_webhook_events claims, and failed Webhooks API reconciliation/cleanup attempts", Idempotency: "marketing_sync_runs klaviyo_native cursor plus Klaviyo profile/list/segment/source-event id and JSON:API cursor; changed-profile events use klaviyo:profile:{id}:{updated}; system webhooks use integration-scoped Klaviyo-Webhook-Id plus body hash; provider webhook reconciliation keys on klaviyo_webhook_id or the opaque endpoint token"}
	case isMarketingNativeSurface(item):
		meta, _ := managedProviderMetadataForItem(item)
		return RetryPolicy{Mode: meta.SyncModel, MaxAttempts: 3, Backoff: meta.Name + " provider API Retry-After/import-ledger retry where supported by the delegated migration adapter; native shell records partial marketing_sync_runs with " + meta.Provider + "_handoff delegated retry cursors", DeadLetter: "marketing integration error state and delegated migration adapter error state", Idempotency: "marketing_sync_runs " + meta.Provider + "_handoff cursor plus provider object ids and migration adapter cursors"}
	case hasSource(item, "commerce"):
		return RetryPolicy{Mode: "commerce_ingest_and_webhook", MaxAttempts: 3, Backoff: "operator/import retry plus webhook replay", DeadLetter: "commerce integration error state", Idempotency: "provider ids and webhook ids"}
	case hasSource(item, "audience_destination"):
		return RetryPolicy{Mode: "audience_delivery_job", MaxAttempts: 5, Backoff: "exponential with jitter", DeadLetter: "audience sync run error details", Idempotency: "audience id plus hashed identity batch"}
	case hasSource(item, "warehouse"):
		return RetryPolicy{Mode: "scheduled_data_job", MaxAttempts: 5, Backoff: "exponential with jitter", DeadLetter: "warehouse connection error state", Idempotency: "object cursor and export window"}
	case hasSource(item, "sending"):
		return RetryPolicy{Mode: "send_loop_and_deliverability_webhook", MaxAttempts: 3, Backoff: "send-loop retry plus provider webhook retry", DeadLetter: "campaign_recipient error state and deliverability provider event log", Idempotency: "campaign_recipient id plus provider event id"}
	case hasSource(item, "outbound_webhooks"):
		return RetryPolicy{Mode: "signed_webhook_delivery", MaxAttempts: 10, Backoff: "exponential with jitter", DeadLetter: "webhook delivery inspector", Idempotency: "event id plus delivery id"}
	case hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		return RetryPolicy{Mode: "source_or_bridge_retry", MaxAttempts: 3, Backoff: "source controlled plus Moosewave idempotency", DeadLetter: "inbound event replay queue", Idempotency: "signature, event id, and source payload fingerprint"}
	case hasSource(item, "developer_marketplace") || item.Badge == BadgeAPISDK:
		return RetryPolicy{Mode: "caller_managed", MaxAttempts: 0, Backoff: "caller controlled", DeadLetter: "API request logs and app monitoring", Idempotency: "Idempotency-Key and resource ids"}
	case isKlaviyoMigrationSurface(item):
		return RetryPolicy{Mode: "klaviyo_migration_source_event", MaxAttempts: 3, Backoff: "Klaviyo Retry-After plus import-ledger retry", DeadLetter: "migration error export and source-event monitor error state", Idempotency: "Klaviyo profile/list/segment/flow/campaign/template id plus JSON:API cursor"}
	case hasSource(item, "migration"):
		return RetryPolicy{Mode: "import_ledger", MaxAttempts: 3, Backoff: "operator retry after dry-run repair", DeadLetter: "migration error export", Idempotency: "source row id and normalized email"}
	case item.Slug == "hubspot":
		return RetryPolicy{Mode: "hubspot_crm_contact_list_deal_event_pull", MaxAttempts: 3, Backoff: "Retry-After aware provider retry", DeadLetter: "crm integration error state", Idempotency: "hubspot contact id, list id, deal/contact ids, and CRM sync cursor"}
	case item.Slug == "salesforce":
		return RetryPolicy{Mode: "salesforce_crm_soql_pull", MaxAttempts: 3, Backoff: "Retry-After aware provider retry", DeadLetter: "crm integration error state", Idempotency: "salesforce record id and SOQL query locator cursor"}
	case item.Slug == "pipedrive":
		return RetryPolicy{Mode: "pipedrive_crm_v2_backfill_webhooks", MaxAttempts: 3, Backoff: "Retry-After aware scheduled provider retry cursor", DeadLetter: "crm integration error state", Idempotency: "pipedrive person/deal/organization/activity ids, webhook route identity, integration-scoped webhook body hash, API v2 cursor, and pipedrive_retry cursor"}
	case item.Slug == "zoho-crm":
		return RetryPolicy{Mode: "zoho_crm_v8_records_pull", MaxAttempts: 3, Backoff: "Retry-After aware provider retry", DeadLetter: "crm integration error state", Idempotency: "zoho record id plus page/page_token cursor"}
	case item.Slug == "microsoft-dynamics-365":
		return RetryPolicy{Mode: "dynamics365_dataverse_records_pull", MaxAttempts: 3, Backoff: "Retry-After aware provider retry", DeadLetter: "crm integration error state", Idempotency: "dataverse record id plus @odata.nextLink cursor"}
	case item.Slug == "keap":
		return RetryPolicy{Mode: "keap_rest_v2_contacts_pull", MaxAttempts: 3, Backoff: "Retry-After aware provider retry plus Keap throttle headers", DeadLetter: "crm integration error state", Idempotency: "keap contact id plus page_token cursor"}
	default:
		return RetryPolicy{Mode: "owning_surface", MaxAttempts: 3, Backoff: "surface specific", DeadLetter: "owning surface error details", Idempotency: "provider resource id"}
	}
}

func syncHistoryFor(item CatalogItem, conn Connection) []SyncHistoryEntry {
	if item.RuntimeStatus == RuntimePlanned {
		return []SyncHistoryEntry{{
			Action:  "roadmap",
			Status:  "planned",
			Message: "No run history exists yet because this connector is planned.",
		}}
	}
	if conn.LastError != "" {
		return []SyncHistoryEntry{{
			At:       conn.LastSyncAt,
			Action:   historyActionFor(item),
			Status:   "error",
			Attempts: 1,
			Message:  "Latest observed run reported an error.",
			Error:    conn.LastError,
		}}
	}
	if conn.LastSyncAt != nil {
		return []SyncHistoryEntry{{
			At:       conn.LastSyncAt,
			Action:   historyActionFor(item),
			Status:   conn.Status,
			Attempts: 1,
			Message:  "Latest observed run from the owning surface.",
		}}
	}
	if conn.Count > 0 {
		return []SyncHistoryEntry{{
			Action:  "connection_inventory",
			Status:  conn.Status,
			Message: "Configuration exists, but no run timestamp was exposed by the owning surface.",
		}}
	}
	return []SyncHistoryEntry{{
		Action:  "setup",
		Status:  "not_configured",
		Message: "Connect or apply a recipe to create the first run record.",
	}}
}

func historyActionFor(item CatalogItem) string {
	switch {
	case isMarketingNativeSurface(item):
		return "marketing_integration_sync"
	case hasSource(item, "commerce"):
		return "commerce_sync"
	case hasSource(item, "audience_destination"):
		return "audience_delivery"
	case hasSource(item, "warehouse"):
		return "warehouse_job"
	case hasSource(item, "sending"):
		return "email_send_or_deliverability_event"
	case hasSource(item, "outbound_webhooks"):
		return "webhook_delivery"
	case hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		return "inbound_ingest"
	case hasSource(item, "developer_marketplace"):
		return "developer_marketplace_activity"
	case hasSource(item, "migration"):
		return "migration_import"
	default:
		return "integration_activity"
	}
}

func auditTrailFor(item CatalogItem, conn Connection) []AuditTrailEntry {
	out := []AuditTrailEntry{{
		Action:  "integration.catalog.visible",
		Actor:   "system",
		Message: fmt.Sprintf("%s is listed as %s.", item.Name, item.Badge),
	}}
	if conn.Count > 0 {
		out = append(out, AuditTrailEntry{
			At:      conn.LastSyncAt,
			Action:  "integration.connection.observed",
			Actor:   "system",
			Message: fmt.Sprintf("%d saved configuration row(s) observed through %s.", conn.Count, surfaceLabel(item)),
		})
	}
	if item.RuntimeStatus == RuntimePlanned {
		out = append(out, AuditTrailEntry{
			Action:  "integration.roadmap.visible",
			Actor:   "system",
			Message: "Visible planned tile; no native connector claim is made.",
		})
	}
	return out
}

func dataDeleteFor(item CatalogItem) []DataDeleteAction {
	if hasSource(item, "support_integration") {
		// The owning privacy/retention workflow is not complete; do not present
		// the held mutation route as an available deletion lifecycle.
		return nil
	}
	actions := []DataDeleteAction{{
		Method:      "DELETE",
		Path:        "/api/v1/integrations/" + item.Slug,
		Description: "Facade disconnect route; delegates to the owning surface when a managed connection exists.",
	}}
	if isShopifyCommerceSurface(item) {
		actions = append(actions, DataDeleteAction{
			Method:      "Provider",
			Path:        "Shopify admin app uninstall",
			Description: "Shopify's current OAuth docs do not expose an explicit token-revocation endpoint; merchant app uninstall/app-uninstalled is the provider-side token invalidation path.",
		})
	}
	if isWixStoresSurface(item) {
		actions = append(actions, DataDeleteAction{
			Method:      "Provider",
			Path:        "Wix app dashboard uninstall",
			Description: "Wix app uninstall/app-instance removed is the provider-side token invalidation path; Moosewave records the signed lifecycle event and moves the connection to needs_auth.",
		})
	}
	if isWixLeadSurface(item) {
		actions = append(actions, DataDeleteAction{
			Method:      "Provider",
			Path:        "Wix app dashboard uninstall",
			Description: "Wix app uninstall/app-instance removed is the provider-side token invalidation path; contact-delete webhooks are verified, deduped, and preserved as provider evidence while profile deletion uses the central privacy workflow.",
		})
	}
	switch {
	case hasSource(item, "commerce"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/commerce/integrations/{id}", Description: "Disconnect the commerce integration, stop normal sync use, preserve local audit evidence, and return provider-cleanup guidance or evidence where supported."})
	case hasSource(item, "crm"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/crm/integrations/{id}", Description: "Disconnect CRM credentials, stop contact/event sync, and retain audit history."})
	case hasSource(item, "lead_capture"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/lead-integrations/{id}", Description: "Disconnect lead-source credentials, stop submission sync, and retain audit history."})
	case hasSource(item, "review_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/review-integrations/{id}", Description: "Disconnect review-platform credentials, stop review sync, and retain imported review audit history."})
	case hasSource(item, "loyalty_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/loyalty-integrations/{id}", Description: "Disconnect loyalty-platform credentials, stop points/reward sync, and retain profile/event audit history."})
	case hasSource(item, "subscription_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/subscription-integrations/{id}", Description: "Disconnect subscription or shipment credentials, stop lifecycle sync, and retain profile/event audit history."})
	case hasSource(item, "support_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/support-integrations/{id}", Description: "Disconnect helpdesk credentials, stop support sync, and retain service-suite audit history."})
	case hasSource(item, "analytics_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/analytics-integrations/{id}", Description: "Disconnect analytics or CDP credentials, stop event/profile sync, and retain profile/event audit history."})
	case hasSource(item, "marketing_integration"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/marketing-integrations/{id}", Description: "Disconnect the marketing integration row, stop native partial sync/backfill, preserve run/audit evidence, and return provider_cleanup guidance. Klaviyo also exposes provider-cleanup/acknowledge for local operator attestation; provider-side credential, OAuth app, webhook, and writeback cleanup remain account actions unless the connector states otherwise."})
	case hasSource(item, "audience_destination"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/audience-destinations/{id}", Description: "Remove destination configuration and stop audience delivery."})
	case hasSource(item, "warehouse"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/warehouse/connections/{id}", Description: "Mark the warehouse connection disconnected, stop scheduled/manual runs, block import-mapping and reverse-ETL mutations, retain run and mapping audit history, and persist provider_cleanup guidance for operator-managed provider-side cleanup."})
	case hasSource(item, "sending"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/deliverability/providers/{id}", Description: "Delete the local deliverability provider row and stop accepting its edge-token configuration; provider-console credentials, webhooks, domains, and SMTP settings may still need cleanup."})
	case hasSource(item, "outbound_webhooks"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/outbound-webhooks/{id}", Description: "Delete endpoint secrets and stop future deliveries."})
	case hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/inbound-webhooks/{id}", Description: "Delete inbound endpoint secrets and disable bridge ingestion."})
	case hasSource(item, "developer_marketplace"):
		actions = append(actions,
			DataDeleteAction{Method: "DELETE", Path: "/api/v1/developer-marketplace/installations/{installation_id}", Description: "Revoke the tenant's marketplace app install and stop future partner access."},
			DataDeleteAction{Method: "POST", Path: "/api/v1/developer-marketplace/oauth/revoke", Description: "Revoke an issued marketplace OAuth access token."},
			DataDeleteAction{Method: "DELETE", Path: "/api/v1/developer-marketplace/apps/{id}/oauth-clients/{client_id}", Description: "Revoke an app OAuth client owned by this tenant."},
		)
	case item.Badge == BadgeAPISDK:
		actions = append(actions, DataDeleteAction{Method: "DELETE", Path: "/api/v1/api-keys/{id}", Description: "Revoke API keys and preserve audit history."})
	case hasSource(item, "migration"):
		actions = append(actions, DataDeleteAction{Method: "POST", Path: "/api/v1/privacy/delete", Description: "Use privacy and retention workflows for imported profile deletion."})
	}
	return actions
}
