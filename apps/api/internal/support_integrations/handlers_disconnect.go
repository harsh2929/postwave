// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

func (d *Deps) DisconnectIntegration(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	cleanup := disconnectCleanupEvidence(integration, d.now())
	if cleanup != nil {
		d.applyManagedProviderCleanup(r.Context(), tenantID, integration, cleanup)
		if recorder, ok := d.Repo.(providerCleanupDisconnectStore); ok {
			err = recorder.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup)
		} else {
			err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
		}
	} else {
		err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
	}
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	out := map[string]any{"ok": true}
	if cleanup != nil {
		out["provider_cleanup"] = cleanup
	}
	writeJSON(w, http.StatusOK, out)
}

func disconnectCleanupEvidence(integration *Integration, recordedAt time.Time) *DisconnectCleanupEvidence {
	if integration == nil {
		return nil
	}
	switch integration.Provider {
	case ProviderZendesk:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Zendesk",
			"zendesk_subdomain",
			firstString(
				settingString(integration.Settings, "subdomain"),
				settingString(integration.Settings, "zendesk_subdomain"),
				settingString(integration.Settings, "provider_subdomain"),
			),
			firstString(
				settingString(integration.Settings, "zendesk_webhook_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"revoke or rotate the Zendesk OAuth/API token if it is no longer used",
			"delete or disable the Moosewave Zendesk webhook, trigger, or automation target",
			"audit duplicate or manually configured Zendesk webhook/trigger targets outside Moosewave",
		)
	case ProviderIntercom:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Intercom",
			"intercom_workspace_id",
			firstString(
				settingString(integration.Settings, "workspace_id"),
				settingString(integration.Settings, "intercom_workspace_id"),
				settingString(integration.Settings, "app_id"),
			),
			firstString(
				settingString(integration.Settings, "intercom_webhook_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"revoke the Intercom OAuth token or uninstall the Intercom app if it is no longer used",
			"delete or disable the Moosewave Intercom app webhook subscription",
			"audit duplicate or manually configured Intercom webhook subscriptions outside Moosewave",
		)
	case ProviderGorgias:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Gorgias",
			"gorgias_account_domain",
			firstString(
				settingString(integration.Settings, "account_domain"),
				settingString(integration.Settings, "domain"),
				settingString(integration.Settings, "subdomain"),
			),
			firstString(
				settingString(integration.Settings, "gorgias_http_integration_id"),
				settingString(integration.Settings, "gorgias_integration_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"revoke or rotate the Gorgias API key if it is no longer used",
			"delete or disable the Moosewave Gorgias HTTP integration callback target",
			"audit duplicate or manually configured Gorgias HTTP integrations outside Moosewave",
		)
	case ProviderFreshdesk:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Freshdesk",
			"freshdesk_account_domain",
			firstString(
				settingString(integration.Settings, "account_domain"),
				settingString(integration.Settings, "domain"),
				settingString(integration.Settings, "subdomain"),
			),
			firstString(
				settingString(integration.Settings, "freshdesk_webhook_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"revoke or rotate the Freshdesk API key if it is no longer used",
			"delete or disable the Moosewave Freshdesk automation webhook rule",
			"audit duplicate or manually configured Freshdesk automation/webhook rules outside Moosewave",
		)
	case ProviderHelpScout:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Help Scout",
			"help_scout_mailbox_id",
			firstString(
				settingString(integration.Settings, "mailbox_id"),
				settingString(integration.Settings, "help_scout_mailbox_id"),
				settingString(integration.Settings, "provider_mailbox_id"),
			),
			firstString(
				settingString(integration.Settings, "help_scout_webhook_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"rotate the Help Scout OAuth app credentials if they are no longer used",
			"delete or disable the Moosewave Help Scout app webhook subscription",
			"audit duplicate or manually configured Help Scout webhook subscriptions outside Moosewave",
		)
	case ProviderFront:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Front",
			"front_inbox_id",
			firstString(settingString(integration.Settings, "inbox_id"), settingString(integration.Settings, "provider_inbox_id")),
			firstString(settingString(integration.Settings, "front_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Front OAuth/API token if it is no longer used",
			"delete or disable any Moosewave Front rule or app webhook target",
			"audit duplicate or manually configured Front webhook rules outside Moosewave",
		)
	case ProviderReamaze:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Reamaze",
			"reamaze_account_domain",
			firstString(settingString(integration.Settings, "account_domain"), settingString(integration.Settings, "domain"), settingString(integration.Settings, "subdomain")),
			firstString(settingString(integration.Settings, "reamaze_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Reamaze API credentials if they are no longer used",
			"delete or disable any Moosewave Reamaze webhook or notification target",
			"audit duplicate or manually configured Reamaze webhook targets outside Moosewave",
		)
	case ProviderCrisp:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Crisp",
			"crisp_website_id",
			firstString(settingString(integration.Settings, "website_id"), settingString(integration.Settings, "provider_website_id")),
			firstString(settingString(integration.Settings, "crisp_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Crisp plugin token if it is no longer used",
			"delete or disable any Moosewave Crisp webhook target",
			"audit duplicate or manually configured Crisp webhook targets outside Moosewave",
		)
	case ProviderKustomer:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Kustomer",
			"kustomer_organization_id",
			firstString(settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "org_id")),
			firstString(settingString(integration.Settings, "kustomer_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Kustomer API key if it is no longer used",
			"delete or disable any Moosewave Kustomer webhook target",
			"audit duplicate or manually configured Kustomer webhook targets outside Moosewave",
		)
	case ProviderDrift:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Drift",
			"drift_workspace_id",
			firstString(settingString(integration.Settings, "workspace_id"), settingString(integration.Settings, "org_id")),
			firstString(settingString(integration.Settings, "drift_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Drift OAuth/API token if it is no longer used",
			"delete or disable any Moosewave Drift webhook subscription",
			"audit duplicate or manually configured Drift webhook subscriptions outside Moosewave",
		)
	case ProviderLiveChat:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "LiveChat",
			"livechat_account_id",
			firstString(settingString(integration.Settings, "account_id"), settingString(integration.Settings, "license_id")),
			firstString(
				strings.Join(liveChatProviderWebhookIDs(integration.Settings), ","),
				settingString(integration.Settings, "livechat_provider_webhook_id"),
				settingString(integration.Settings, "livechat_registered_webhook_id"),
				settingString(integration.Settings, "livechat_webhook_id"),
				settingString(integration.Settings, "provider_webhook_id"),
				settingString(integration.Settings, "webhook_id"),
			),
			"revoke or rotate the LiveChat personal access token if it is no longer used",
			"delete or disable any Moosewave LiveChat webhook target",
			"audit duplicate or manually configured LiveChat webhook targets outside Moosewave",
		)
	case ProviderZohoDesk:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Zoho Desk",
			"zoho_desk_organization_id",
			firstString(settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "org_id")),
			firstString(settingString(integration.Settings, "zoho_desk_webhook_id"), settingString(integration.Settings, "notification_channel_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Zoho Desk OAuth token if it is no longer used",
			"delete or disable any Moosewave Zoho Desk notification channel or webhook target",
			"audit duplicate or manually configured Zoho Desk notification channels outside Moosewave",
		)
	case ProviderOlark:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Olark",
			"olark_site_id",
			firstString(settingString(integration.Settings, "site_id"), settingString(integration.Settings, "provider_site_id")),
			firstString(settingString(integration.Settings, "olark_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Olark API token if it is no longer used",
			"delete or disable any Moosewave Olark webhook target",
			"audit duplicate or manually configured Olark webhook targets outside Moosewave",
		)
	case ProviderGladly:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Gladly",
			"gladly_organization_domain",
			firstString(
				settingString(integration.Settings, "organization_domain"),
				settingString(integration.Settings, "organization_id"),
				settingString(integration.Settings, "gladly_organization_domain"),
				settingString(integration.Settings, "account_domain"),
				settingString(integration.Settings, "domain"),
				settingString(integration.Settings, "subdomain"),
			),
			firstString(settingString(integration.Settings, "gladly_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Gladly API token if it is no longer used",
			"delete or disable any Moosewave Gladly webhook target",
			"audit duplicate or manually configured Gladly webhook targets outside Moosewave",
		)
	case ProviderGroove:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Groove",
			"groove_mailbox_id",
			firstString(settingString(integration.Settings, "mailbox_id"), settingString(integration.Settings, "provider_mailbox_id"), settingString(integration.Settings, "groove_mailbox_id")),
			firstString(settingString(integration.Settings, "groove_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Groove API token if it is no longer used",
			"delete or disable any Moosewave Groove webhook target",
			"audit duplicate or manually configured Groove webhook targets outside Moosewave",
		)
	case ProviderHelpCrunch:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "HelpCrunch",
			"helpcrunch_organization_id",
			firstString(settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "helpcrunch_organization_id"), settingString(integration.Settings, "provider_organization_id")),
			firstString(settingString(integration.Settings, "helpcrunch_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the HelpCrunch Public API key if it is no longer used",
			"delete or disable any Moosewave HelpCrunch webhook target",
			"audit duplicate or manually configured HelpCrunch webhook targets outside Moosewave",
		)
	case ProviderJiraServiceManagement:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Jira Service Management",
			"jira_service_management_site_id",
			firstString(settingString(integration.Settings, "site_id"), settingString(integration.Settings, "cloud_id"), settingString(integration.Settings, "site_url")),
			firstString(settingString(integration.Settings, "jira_service_management_webhook_id"), settingString(integration.Settings, "jira_service_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Atlassian OAuth/API token if it is no longer used",
			"delete or disable any Moosewave Jira Service Management webhook target",
			"audit duplicate or manually configured Jira webhooks outside Moosewave",
		)
	case ProviderLinear:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Linear",
			"linear_workspace_id",
			firstString(settingString(integration.Settings, "workspace_id"), settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "linear_workspace_id")),
			firstString(settingString(integration.Settings, "linear_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Linear OAuth/API token if it is no longer used",
			"delete or disable any Moosewave Linear webhook subscription",
			"audit duplicate or manually configured Linear webhook subscriptions outside Moosewave",
		)
	case ProviderAsanaSupport:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Asana Support",
			"asana_workspace_id",
			firstString(settingString(integration.Settings, "workspace_id"), settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "asana_workspace_id")),
			firstString(settingString(integration.Settings, "asana_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Asana OAuth/API token if it is no longer used",
			"delete or disable any Moosewave Asana webhook subscription",
			"audit duplicate or manually configured Asana webhook subscriptions outside Moosewave",
		)
	case ProviderClickUpSupport:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "ClickUp Support",
			"clickup_workspace_id",
			firstString(settingString(integration.Settings, "workspace_id"), settingString(integration.Settings, "team_id"), settingString(integration.Settings, "clickup_workspace_id")),
			firstString(settingString(integration.Settings, "clickup_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the ClickUp OAuth/API token if it is no longer used",
			"delete or disable any Moosewave ClickUp webhook subscription",
			"audit duplicate or manually configured ClickUp webhook subscriptions outside Moosewave",
		)
	case ProviderKayako:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Kayako",
			"kayako_account_domain",
			firstString(settingString(integration.Settings, "account_domain"), settingString(integration.Settings, "domain"), settingString(integration.Settings, "subdomain")),
			firstString(settingString(integration.Settings, "kayako_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Kayako API credentials if they are no longer used",
			"delete or disable any Moosewave Kayako webhook target",
			"audit duplicate or manually configured Kayako webhook targets outside Moosewave",
		)
	case ProviderHubSpotServiceHub:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "HubSpot Service Hub",
			"hubspot_portal_id",
			firstString(settingString(integration.Settings, "portal_id"), settingString(integration.Settings, "hub_id")),
			firstString(settingString(integration.Settings, "hubspot_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke the HubSpot OAuth token or uninstall the HubSpot app if it is no longer used",
			"delete or disable any Moosewave HubSpot Service Hub webhook subscription",
			"audit duplicate or manually configured HubSpot webhook subscriptions outside Moosewave",
		)
	case ProviderSalesforceServiceCloud:
		return supportDisconnectCleanupEvidence(*integration, recordedAt, "Salesforce Service Cloud",
			"salesforce_service_cloud_instance_url",
			firstString(settingString(integration.Settings, "instance_url"), settingString(integration.Settings, "api_base_url")),
			firstString(settingString(integration.Settings, "salesforce_service_cloud_webhook_id"), settingString(integration.Settings, "salesforce_webhook_id"), settingString(integration.Settings, "provider_webhook_id"), settingString(integration.Settings, "webhook_id")),
			"revoke or rotate the Salesforce Service Cloud OAuth/access token if it is no longer used",
			"delete or disable any Moosewave Salesforce Service Cloud webhook, CDC, Pub/Sub, or Platform Event subscription",
			"audit duplicate or manually configured Salesforce notification targets and connected-app permissions outside Moosewave",
		)
	default:
		return nil
	}
}

func (d *Deps) applyManagedProviderCleanup(ctx context.Context, tenantID string, integration *Integration, cleanup *DisconnectCleanupEvidence) {
	if integration == nil || cleanup == nil {
		return
	}
	switch integration.Provider {
	case ProviderZendesk:
		d.applyZendeskManagedProviderCleanup(ctx, tenantID, integration, cleanup)
	case ProviderGorgias:
		d.applyGorgiasManagedProviderCleanup(ctx, tenantID, integration, cleanup)
	case ProviderLiveChat:
		d.applyLiveChatManagedProviderCleanup(ctx, tenantID, integration, cleanup)
	}
}

func (d *Deps) applyZendeskManagedProviderCleanup(ctx context.Context, tenantID string, integration *Integration, cleanup *DisconnectCleanupEvidence) {
	webhookID := strings.TrimSpace(cleanup.ProviderWebhookID)
	if webhookID == "" {
		cleanup.WebhookCleanupStatus = "skipped_missing_webhook_id"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"No zendesk_webhook_id was stored, so Moosewave could not target a managed Zendesk webhook for deletion.",
		)
		return
	}
	cleaner, ok := d.ZendeskBackfiller.(ZendeskWebhookCleaner)
	if !ok || cleaner == nil {
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"Zendesk webhook cleanup skipped because no ZendeskWebhookCleaner is configured in this API process.",
		)
		return
	}
	result, err := cleaner.DeleteZendeskWebhook(ctx, tenantID, *integration, webhookID)
	if err != nil {
		cleanup.WebhookCleanupStatus = "failed_operator_cleanup_required"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"Zendesk Webhooks API DELETE failed; Zendesk webhook cleanup remains operator-managed.",
			supportCleanupErrorEvidence("Zendesk webhook cleanup", err),
		)
		return
	}
	status := strings.TrimSpace(result.Status)
	if status == "" {
		status = "deleted"
	}
	cleanup.ProviderCleanupPosture = "partial_managed_webhook_cleanup_operator_credentials"
	cleanup.ManagedProviderCleanup = true
	cleanup.WebhookCleanupStatus = status
	cleanup.ProviderCleanupEvidence = []string{
		"Moosewave called the Zendesk Webhooks API DELETE endpoint for the stored zendesk_webhook_id before local disconnect.",
		"Zendesk webhook cleanup status: " + status,
		"Zendesk trigger/automation cleanup, duplicate webhook audits, and OAuth/API-token revocation remain operator-managed until live certification proves the full cleanup flow.",
	}
}

func (d *Deps) applyGorgiasManagedProviderCleanup(ctx context.Context, tenantID string, integration *Integration, cleanup *DisconnectCleanupEvidence) {
	integrationID := strings.TrimSpace(cleanup.ProviderWebhookID)
	if integrationID == "" {
		cleanup.WebhookCleanupStatus = "skipped_missing_http_integration_id"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"No gorgias_http_integration_id was stored, so Moosewave could not target a managed Gorgias HTTP integration for deletion.",
		)
		return
	}
	cleaner, ok := d.GorgiasBackfiller.(GorgiasHTTPIntegrationCleaner)
	if !ok || cleaner == nil {
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"Gorgias HTTP integration cleanup skipped because no GorgiasHTTPIntegrationCleaner is configured in this API process.",
		)
		return
	}
	result, err := cleaner.DeleteGorgiasHTTPIntegration(ctx, tenantID, *integration, integrationID)
	if err != nil {
		cleanup.WebhookCleanupStatus = "failed_operator_cleanup_required"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"Gorgias Integrations API DELETE failed; Gorgias HTTP integration cleanup remains operator-managed.",
			supportCleanupErrorEvidence("Gorgias HTTP integration cleanup", err),
		)
		return
	}
	status := strings.TrimSpace(result.Status)
	if status == "" {
		status = "deleted"
	}
	cleanup.ProviderCleanupPosture = "partial_managed_http_integration_cleanup_operator_credentials"
	cleanup.ManagedProviderCleanup = true
	cleanup.WebhookCleanupStatus = status
	cleanup.ProviderCleanupEvidence = []string{
		"Moosewave called the Gorgias Integrations API DELETE endpoint for the stored gorgias_http_integration_id before local disconnect.",
		"Gorgias HTTP integration cleanup status: " + status,
		"Gorgias rule references, duplicate/manual HTTP integrations, and API-key revocation remain operator-managed until live certification proves the full cleanup flow.",
	}
}

func (d *Deps) applyLiveChatManagedProviderCleanup(ctx context.Context, tenantID string, integration *Integration, cleanup *DisconnectCleanupEvidence) {
	if !liveChatManagedWebhook(integration.Settings) {
		return
	}
	providerIDs := liveChatProviderWebhookIDs(integration.Settings)
	if len(providerIDs) == 0 {
		cleanup.WebhookCleanupStatus = "skipped_missing_provider_webhook_id"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"No livechat_provider_webhook_ids were stored, so Moosewave could not target a managed LiveChat webhook for deletion.",
		)
		return
	}
	ownerClientID := liveChatOwnerClientID(integration.Settings)
	if ownerClientID == "" {
		cleanup.WebhookCleanupStatus = "skipped_missing_owner_client_id"
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"No LiveChat owner_client_id was stored, so Moosewave could not unregister managed LiveChat webhooks.",
		)
		return
	}
	manager, ok := d.LiveChatBackfiller.(LiveChatWebhookManager)
	if !ok || manager == nil {
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
			"LiveChat webhook cleanup skipped because no LiveChatWebhookManager is configured in this API process.",
		)
		return
	}
	statuses := make([]string, 0, len(providerIDs))
	for _, providerID := range providerIDs {
		result, err := manager.UnregisterLiveChatWebhook(ctx, tenantID, *integration, providerID, ownerClientID)
		if err != nil {
			cleanup.WebhookCleanupStatus = "failed_operator_cleanup_required"
			cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence,
				"LiveChat Configuration API unregister_webhook failed; LiveChat webhook cleanup remains operator-managed.",
				supportCleanupErrorEvidence("LiveChat webhook cleanup", err),
			)
			return
		}
		status := strings.TrimSpace(result.Status)
		if status == "" {
			status = "deleted"
		}
		statuses = append(statuses, strings.TrimSpace(providerID)+":"+status)
	}
	cleanup.ProviderCleanupPosture = "partial_managed_webhook_cleanup_operator_credentials"
	cleanup.ManagedProviderCleanup = true
	cleanup.WebhookCleanupStatus = "deleted"
	cleanup.ProviderWebhookID = strings.Join(providerIDs, ",")
	cleanup.ProviderCleanupEvidence = []string{
		"Moosewave called the LiveChat Configuration API unregister_webhook endpoint for stored Moosewave-owned LiveChat webhook IDs before local disconnect.",
		"LiveChat webhook cleanup statuses: " + strings.Join(statuses, ", "),
		"LiveChat personal-access-token rotation, duplicate/manual webhook audits, and live cleanup proof remain operator-managed until certification proves the full cleanup flow.",
	}
}

func supportCleanupErrorEvidence(prefix string, err error) string {
	var restErr ZendeskRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			return prefix + " failed with provider HTTP " + strconv.Itoa(restErr.StatusCode) + " and Retry-After " + restErr.RetryAfter.String() + "."
		}
		return prefix + " failed with provider HTTP " + strconv.Itoa(restErr.StatusCode) + "."
	}
	var gorgiasErr GorgiasRESTError
	if errors.As(err, &gorgiasErr) {
		if gorgiasErr.RetryAfter > 0 {
			return prefix + " failed with provider HTTP " + strconv.Itoa(gorgiasErr.StatusCode) + " and Retry-After " + gorgiasErr.RetryAfter.String() + "."
		}
		return prefix + " failed with provider HTTP " + strconv.Itoa(gorgiasErr.StatusCode) + "."
	}
	var liveChatErr LiveChatRESTError
	if errors.As(err, &liveChatErr) {
		if liveChatErr.RetryAfter > 0 {
			return prefix + " failed with provider HTTP " + strconv.Itoa(liveChatErr.StatusCode) + " and Retry-After " + liveChatErr.RetryAfter.String() + "."
		}
		return prefix + " failed with provider HTTP " + strconv.Itoa(liveChatErr.StatusCode) + "."
	}
	return prefix + " failed: " + zendeskTruncate(err.Error(), 240)
}

func supportDisconnectCleanupEvidence(integration Integration, recordedAt time.Time, providerName, scopeType, scopeID, webhookID, credentialAction, webhookAction, auditAction string) *DisconnectCleanupEvidence {
	webhookSecretRef := firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_auth_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "notification_token_ref"),
		settingString(integration.Settings, "front_webhook_secret_ref"),
		settingString(integration.Settings, "front_webhook_signature_ref"),
		settingString(integration.Settings, "crisp_webhook_secret_ref"),
		settingString(integration.Settings, "crisp_webhook_signature_ref"),
		settingString(integration.Settings, "kustomer_webhook_secret_ref"),
		settingString(integration.Settings, "kustomer_webhook_signature_ref"),
		settingString(integration.Settings, "drift_webhook_secret_ref"),
		settingString(integration.Settings, "drift_webhook_token_ref"),
		settingString(integration.Settings, "drift_verification_token_ref"),
		settingString(integration.Settings, "livechat_webhook_secret_ref"),
		settingString(integration.Settings, "livechat_webhook_signature_ref"),
		settingString(integration.Settings, "hubspot_service_hub_webhook_secret_ref"),
		settingString(integration.Settings, "hubspot_webhook_secret_ref"),
		settingString(integration.Settings, "hubspot_client_secret_ref"),
		settingString(integration.Settings, "zendesk_webhook_secret_ref"),
		settingString(integration.Settings, "gorgias_webhook_secret_ref"),
		settingString(integration.Settings, "gladly_webhook_token_ref"),
		settingString(integration.Settings, "gladly_webhook_secret_ref"),
		settingString(integration.Settings, "helpcrunch_webhook_signing_key_ref"),
		settingString(integration.Settings, "helpcrunch_webhook_secret_ref"),
		settingString(integration.Settings, "jira_service_management_webhook_secret_ref"),
		settingString(integration.Settings, "linear_webhook_secret_ref"),
		settingString(integration.Settings, "asana_webhook_secret_ref"),
		settingString(integration.Settings, "clickup_webhook_secret_ref"),
	)
	webhookStatus := "not_configured_in_postwave"
	if webhookSecretRef != "" || webhookID != "" {
		webhookStatus = "operator_cleanup_required"
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "operator_action_required",
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       scopeType,
		ProviderScopeID:         scopeID,
		ProviderWebhookID:       webhookID,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: webhookSecretRef != "",
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local support integration is marked disconnected",
			"scheduled support provider pulls exclude disconnected rows",
			"provider-routed support webhooks no longer resolve this row",
			"support sync and webhook audit history is retained",
		},
		ProviderConsoleActions: []string{
			credentialAction,
			webhookAction,
			auditAction,
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call a " + providerName + " provider-cleanup API on support disconnect",
			providerName + " webhook and credential cleanup remains operator-managed until managed cleanup automation is certified",
		},
	}
}
