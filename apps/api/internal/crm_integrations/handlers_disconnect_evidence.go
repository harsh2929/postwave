// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"encoding/json"
	"strings"
	"time"
)

// Disconnect cleanup evidence: the per-provider credential, webhook and OAuth
// revocation outcomes recorded when a CRM integration is disconnected. The
// DisconnectIntegration handler itself stays in handlers.go.

type crmDisconnectCleanupInput struct {
	pipedriveWebhookCleanup          PipedriveWebhookCleanupSummary
	pipedriveWebhookCleanupAttempted bool
	pipedriveOAuthRevocation         PipedriveOAuthRevocationSummary
	hubSpotOAuthRevocation           HubSpotOAuthRevocationSummary
	salesforceOAuthRevocation        SalesforceOAuthRevocationSummary
	zohoOAuthRevocation              ZohoOAuthRevocationSummary
}

type crmOAuthRevocationEvidence struct {
	revoked   bool
	skipped   bool
	reason    string
	tokenType string
}

func crmDisconnectCleanupEvidence(integration *Integration, recordedAt time.Time, in crmDisconnectCleanupInput) *DisconnectCleanupEvidence {
	if integration == nil {
		return nil
	}
	if recordedAt.IsZero() {
		recordedAt = time.Now().UTC()
	}
	evidence := &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "operator_action_required",
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CredentialRefPresent:    strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref"))) != "",
		WebhookCleanupStatus:    "operator_review_provider_webhooks",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects:         crmDisconnectPostwaveEffects(integration.Provider),
		ProviderConsoleActions:  []string{"review provider-side apps, API keys, OAuth installs, webhooks, and tokens for cleanup"},
		ProviderCleanupEvidence: []string{"Moosewave marks the local CRM integration disconnected and retains CRM sync/webhook audit history"},
	}
	switch integration.Provider {
	case ProviderHubSpot:
		revocation := crmHubSpotOAuthRevocationEvidence(in.hubSpotOAuthRevocation)
		evidence.ProviderCleanupPosture = "mixed_postwave_oauth_operator_hubspot_console"
		evidence.ProviderScopeType = "hubspot_portal_id"
		evidence.ProviderScopeID = firstString(settingString(integration.Settings, "portal_id"), settingString(integration.Settings, "hubspot_portal_id"))
		evidence.WebhookCleanupStatus = "app_level_webhook_subscription_shared_no_per_tenant_cleanup"
		evidence.CredentialCleanupStatus = crmHubSpotCredentialCleanupStatus(revocation, evidence.CredentialRefPresent)
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the HubSpot private app token if this connection used a private app credential",
			"uninstall the Moosewave HubSpot OAuth app if the account should no longer grant access",
			"review app-level HubSpot webhook subscriptions and duplicate/manual Moosewave webhook targets",
			"review HubSpot list and deal sync settings that were mapped into Moosewave lists or events",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave revokes managed HubSpot OAuth refresh tokens when present during disconnect",
			"Moosewave deletes local managed HubSpot OAuth credential envelopes after the row is disconnected",
			"HubSpot app-level webhooks are shared by the developer app and are not deleted per tenant during disconnect",
			"Private app token revocation, OAuth app uninstall review, and duplicate/manual webhook cleanup remain HubSpot-side actions",
		}
		crmApplyOAuthRevocationEvidence(evidence, revocation)
	case ProviderSalesforce:
		revocation := crmSalesforceOAuthRevocationEvidence(in.salesforceOAuthRevocation)
		evidence.ProviderCleanupPosture = "mixed_postwave_oauth_operator_salesforce_console"
		evidence.ProviderScopeType = "salesforce_org_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "org_id")
		evidence.WebhookCleanupStatus = "operator_review_connected_app_or_streaming_subscription_cleanup"
		evidence.CredentialCleanupStatus = crmSalesforceCredentialCleanupStatus(revocation, evidence.CredentialRefPresent)
		evidence.ProviderConsoleActions = []string{
			"review Salesforce Connected App policies and revoke leftover access if needed",
			"delete or disable any manually configured CDC, Platform Event, or webhook subscriptions pointing at Moosewave",
			"review CampaignMember and Task settings that were mapped into Moosewave lists or events",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave revokes managed Salesforce OAuth refresh tokens when present during disconnect",
			"Moosewave deletes local managed Salesforce OAuth credential envelopes after the row is disconnected",
			"Salesforce CDC/Platform Event cleanup remains operator-managed until the streaming runtime is certified",
		}
		crmApplyOAuthRevocationEvidence(evidence, revocation)
	case ProviderPipedrive:
		revocation := crmPipedriveOAuthRevocationEvidence(in.pipedriveOAuthRevocation)
		evidence.ProviderCleanupPosture = "mixed_postwave_webhook_oauth_operator_pipedrive_console"
		evidence.ProviderScopeType = "pipedrive_company_id"
		evidence.ProviderScopeID = firstString(settingString(integration.Settings, "pipedrive_company_id"), settingString(integration.Settings, "company_id"))
		evidence.Endpoint = firstString(in.pipedriveWebhookCleanup.Endpoint, settingString(integration.Settings, "pipedrive_webhook_endpoint"))
		evidence.ProviderWebhookIDs = crmPipedriveWebhookIDs(integration.Settings)
		evidence.DeletedProviderWebhookIDs = crmPipedriveDeletedWebhookIDs(in.pipedriveWebhookCleanup)
		evidence.WebhookCleanupStatus = crmPipedriveWebhookCleanupStatus(in.pipedriveWebhookCleanupAttempted, evidence.DeletedProviderWebhookIDs, integration.Settings)
		evidence.CredentialCleanupStatus = crmPipedriveCredentialCleanupStatus(revocation, evidence.CredentialRefPresent)
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate any Pipedrive API token if this connection used a private token",
			"audit Pipedrive for duplicate or manually created Moosewave webhooks",
			"uninstall or review the Pipedrive OAuth app grant if no longer needed",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave deletes stored Moosewave-owned Pipedrive webhook registrations when endpoint metadata and credentials are available",
			"Moosewave revokes managed Pipedrive OAuth refresh tokens when present during disconnect",
			"Moosewave deletes local managed Pipedrive OAuth credential envelopes before persisting the disconnected row when present",
			"API-token revocation and duplicate/manual webhook cleanup remain Pipedrive-side operator actions",
		}
		crmApplyOAuthRevocationEvidence(evidence, revocation)
	case ProviderZohoCRM:
		revocation := crmZohoOAuthRevocationEvidence(in.zohoOAuthRevocation)
		credentialRef := zohoCredentialRef(*integration)
		evidence.ProviderCleanupPosture = "mixed_postwave_oauth_operator_zoho_console"
		evidence.ProviderScopeType = "zoho_organization_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "organization_id")
		evidence.WebhookCleanupStatus = "operator_review_zoho_notification_channels"
		evidence.CredentialCleanupStatus = crmZohoCredentialCleanupStatus(revocation, evidence.CredentialRefPresent, zohoIsStoredCredentialRef(credentialRef))
		evidence.ProviderConsoleActions = []string{
			"review the Zoho connected app grant and revoke any non-Moosewave credentials if needed",
			"delete or disable Zoho Notification API watch channels pointing at Moosewave",
			"review Zoho account, deal, and activity automation settings that may reference Moosewave exports",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave revokes managed Zoho OAuth refresh tokens when present during disconnect",
			"Moosewave deletes local managed Zoho OAuth credential envelopes after the row is disconnected",
			"Zoho Notification API channel cleanup remains operator-managed until the notification runtime is certified",
		}
		crmApplyOAuthRevocationEvidence(evidence, revocation)
	case ProviderDynamics365:
		credentialRef := dynamics365CredentialRef(*integration)
		evidence.ProviderCleanupPosture = "mixed_postwave_local_oauth_operator_microsoft_console"
		evidence.ProviderScopeType = "dynamics365_environment_url"
		evidence.ProviderScopeID = firstString(settingString(integration.Settings, "environment_url"), settingString(integration.Settings, "api_base_url"))
		evidence.WebhookCleanupStatus = "operator_review_dataverse_change_tracking_or_webhook_cleanup"
		evidence.CredentialCleanupStatus = crmDynamics365CredentialCleanupStatus(evidence.CredentialRefPresent, dynamics365IsStoredCredentialRef(credentialRef))
		evidence.ProviderConsoleActions = []string{
			"review Microsoft Entra app grants and revoke leftover access if needed",
			"delete or disable any Dataverse webhooks, service endpoints, or change-tracking exports pointing at Moosewave",
			"review Dataverse workflow, solution, list, account, opportunity, and activity settings that may reference Moosewave",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave deletes local managed Microsoft Dynamics 365 OAuth credential envelopes after the row is disconnected",
			"Microsoft Entra refresh-token revocation is provider-console/operator-managed because this connector has no provider revocation endpoint",
			"Dataverse change-tracking and webhook cleanup remain operator-managed until that runtime is certified",
		}
		if evidence.CredentialRefPresent {
			crmApplyOAuthRevocationEvidence(evidence, crmOAuthRevocationEvidence{skipped: true, reason: "provider_revocation_endpoint_unavailable", tokenType: "refresh_token"})
		}
	case ProviderKeap:
		credentialRef := keapCredentialRef(*integration)
		evidence.ProviderCleanupPosture = "mixed_postwave_local_credential_operator_keap_console"
		evidence.ProviderScopeType = "keap_account_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "account_id")
		evidence.WebhookCleanupStatus = "operator_review_keap_rest_hooks_or_webhook_cleanup"
		evidence.CredentialCleanupStatus = crmKeapCredentialCleanupStatus(evidence.CredentialRefPresent, keapIsStoredCredentialRef(credentialRef))
		evidence.ProviderConsoleActions = []string{
			"review Keap OAuth app grants, Personal Access Tokens, and Service Account Keys and revoke leftovers if needed",
			"delete or disable duplicate/manual Keap REST Hooks or webhook targets pointing at Moosewave",
			"review Keap tag, campaign, order, appointment, task, opportunity, and product automations that may reference Moosewave",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave deletes local managed Keap OAuth/PAT/SAK credential envelopes after the row is disconnected",
			"Keap provider credential revocation remains provider-console/operator-managed because this connector has no provider revocation endpoint",
			"Keap REST Hooks and webhook cleanup remain operator-managed until that runtime is certified",
		}
		if evidence.CredentialRefPresent {
			crmApplyOAuthRevocationEvidence(evidence, crmOAuthRevocationEvidence{skipped: true, reason: "provider_revocation_endpoint_unavailable", tokenType: "provider_credential"})
		}
	case ProviderClose:
		evidence.ProviderCleanupPosture = "operator_managed_close_console"
		evidence.ProviderScopeType = "close_organization_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "organization_id")
		evidence.WebhookCleanupStatus = "operator_review_close_webhooks"
		evidence.CredentialCleanupStatus = crmOperatorCredentialCleanupStatus(evidence.CredentialRefPresent, "operator_revoke_or_rotate_close_api_key_if_no_longer_used")
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the Close API key if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual Close webhooks or workflow callbacks pointing at Moosewave",
			"review Close lead, opportunity, activity, and task automations that may reference Moosewave exports",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local Close CRM integration disconnected and stops manual and scheduled contact pulls",
			"Moosewave preserves Close CRM sync history and provider_cleanup evidence for operator review",
			"Close API-key and webhook cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
	case ProviderCopper:
		evidence.ProviderCleanupPosture = "operator_managed_copper_console"
		evidence.ProviderScopeType = "copper_account_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "account_id")
		evidence.WebhookCleanupStatus = "operator_review_copper_webhooks"
		evidence.CredentialCleanupStatus = crmOperatorCredentialCleanupStatus(evidence.CredentialRefPresent, "operator_revoke_or_rotate_copper_api_key_if_no_longer_used")
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the Copper API key if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual Copper webhooks or workflow callbacks pointing at Moosewave",
			"review Copper company, opportunity, activity, and project automations that may reference Moosewave exports",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local Copper CRM integration disconnected and stops manual and scheduled people pulls",
			"Moosewave preserves Copper CRM sync history and provider_cleanup evidence for operator review",
			"Copper API-key and webhook cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
	case ProviderFreshsales:
		evidence.ProviderCleanupPosture = "operator_managed_freshsales_console"
		evidence.ProviderScopeType = "freshsales_account_domain"
		evidence.ProviderScopeID = settingString(integration.Settings, "account_domain")
		evidence.WebhookCleanupStatus = "operator_review_freshsales_webhooks"
		evidence.CredentialCleanupStatus = crmOperatorCredentialCleanupStatus(evidence.CredentialRefPresent, "operator_revoke_or_rotate_freshsales_api_key_if_no_longer_used")
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the Freshsales API key if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual Freshsales webhooks or workflow callbacks pointing at Moosewave",
			"review Freshsales account, deal, activity, and task automations that may reference Moosewave exports",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local Freshsales CRM integration disconnected and stops manual and scheduled contact pulls",
			"Moosewave preserves Freshsales CRM sync history and provider_cleanup evidence for operator review",
			"Freshsales API-key and webhook cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
	case ProviderHighLevel:
		credentialRef := highLevelCredentialRef(*integration)
		evidence.ProviderCleanupPosture = "operator_managed_highlevel_console"
		if highLevelIsStoredCredentialRef(credentialRef) {
			evidence.ProviderCleanupPosture = "mixed_postwave_local_credential_operator_highlevel_console"
		}
		evidence.ProviderScopeType = "highlevel_location_id"
		evidence.ProviderScopeID = settingString(integration.Settings, "location_id")
		evidence.WebhookCleanupStatus = "operator_review_highlevel_webhooks"
		evidence.CredentialCleanupStatus = crmHighLevelCredentialCleanupStatus(evidence.CredentialRefPresent, highLevelIsStoredCredentialRef(credentialRef))
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the HighLevel OAuth/API credential if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual HighLevel webhooks or workflow callbacks pointing at Moosewave",
			"review HighLevel opportunity, calendar, appointment, conversation, and workflow automations that may reference Moosewave exports",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local HighLevel CRM integration disconnected and stops manual and scheduled contact pulls",
			"Moosewave deletes local managed HighLevel OAuth credential envelopes after the row is disconnected when the connection uses a Moosewave-owned credential reference",
			"Moosewave preserves HighLevel CRM sync history and provider_cleanup evidence for operator review",
			"HighLevel provider credential revocation and webhook cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
		if evidence.CredentialRefPresent {
			crmApplyOAuthRevocationEvidence(evidence, crmOAuthRevocationEvidence{skipped: true, reason: "provider_revocation_endpoint_unavailable", tokenType: "provider_credential"})
		}
	case ProviderPostscript:
		evidence.ProviderCleanupPosture = "operator_managed_postscript_console"
		evidence.ProviderScopeType = "postscript_subscriber_source"
		evidence.ProviderScopeID = firstString(settingString(integration.Settings, "shop_domain"), settingString(integration.Settings, "account_id"), settingString(integration.Settings, "api_base_url"))
		evidence.WebhookCleanupStatus = "operator_review_postscript_webhooks_or_keyword_automations"
		evidence.CredentialCleanupStatus = crmOperatorCredentialCleanupStatus(evidence.CredentialRefPresent, "operator_revoke_or_rotate_postscript_api_key_if_no_longer_used")
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the Postscript API key if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual Postscript webhooks, keyword automations, or subscriber exports pointing at Moosewave",
			"review Postscript opt-in, unsubscribe, and SMS keyword workflows that may reference Moosewave",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local Postscript CRM/SMS integration disconnected and stops manual and scheduled subscriber pulls",
			"Moosewave preserves Postscript CRM sync history and provider_cleanup evidence for operator review",
			"Postscript API-key, webhook, and opt-in workflow cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
	case ProviderAttentive:
		evidence.ProviderCleanupPosture = "operator_managed_attentive_console"
		evidence.ProviderScopeType = "attentive_subscriber_source"
		evidence.ProviderScopeID = firstString(settingString(integration.Settings, "shop_domain"), settingString(integration.Settings, "account_id"), settingString(integration.Settings, "api_base_url"))
		evidence.WebhookCleanupStatus = "operator_review_attentive_webhooks_or_keyword_automations"
		evidence.CredentialCleanupStatus = crmOperatorCredentialCleanupStatus(evidence.CredentialRefPresent, "operator_revoke_or_rotate_attentive_api_key_if_no_longer_used")
		evidence.ProviderConsoleActions = []string{
			"revoke or rotate the Attentive API key if it is no longer used by any Moosewave connection",
			"delete or disable duplicate/manual Attentive webhooks, journeys, or subscriber exports pointing at Moosewave",
			"review Attentive opt-in, unsubscribe, and SMS keyword workflows that may reference Moosewave",
		}
		evidence.ProviderCleanupEvidence = []string{
			"Moosewave marks the local Attentive CRM/SMS integration disconnected and stops manual and scheduled subscriber pulls",
			"Moosewave preserves Attentive CRM sync history and provider_cleanup evidence for operator review",
			"Attentive API-key, webhook, and opt-in workflow cleanup remain operator-managed until a provider cleanup runtime is certified",
		}
	}
	return evidence
}

func crmDisconnectCleanupEvidenceFromSettings(settings map[string]any) *DisconnectCleanupEvidence {
	raw, ok := settings["provider_cleanup"]
	if !ok || raw == nil {
		return nil
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var out DisconnectCleanupEvidence
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil
	}
	if out.Provider == "" && out.Status == "" {
		return nil
	}
	return &out
}

func crmDisconnectPostwaveEffects(provider string) []string {
	return []string{
		"local CRM integration is marked disconnected",
		"manual and scheduled " + provider + " CRM pulls stop for this integration",
		"provider webhook callbacks no longer resolve disconnected rows",
		"CRM sync and webhook audit history is retained",
	}
}

func crmHubSpotOAuthRevocationEvidence(summary HubSpotOAuthRevocationSummary) crmOAuthRevocationEvidence {
	return crmOAuthRevocationEvidence{revoked: summary.Revoked, skipped: summary.Skipped, reason: summary.Reason, tokenType: summary.TokenType}
}

func crmSalesforceOAuthRevocationEvidence(summary SalesforceOAuthRevocationSummary) crmOAuthRevocationEvidence {
	return crmOAuthRevocationEvidence{revoked: summary.Revoked, skipped: summary.Skipped, reason: summary.Reason, tokenType: summary.TokenType}
}

func crmPipedriveOAuthRevocationEvidence(summary PipedriveOAuthRevocationSummary) crmOAuthRevocationEvidence {
	return crmOAuthRevocationEvidence{revoked: summary.Revoked, skipped: summary.Skipped, reason: summary.Reason, tokenType: summary.TokenType}
}

func crmZohoOAuthRevocationEvidence(summary ZohoOAuthRevocationSummary) crmOAuthRevocationEvidence {
	return crmOAuthRevocationEvidence{revoked: summary.Revoked, skipped: summary.Skipped, reason: summary.Reason, tokenType: summary.TokenType}
}

func crmApplyOAuthRevocationEvidence(evidence *DisconnectCleanupEvidence, revocation crmOAuthRevocationEvidence) {
	if evidence == nil {
		return
	}
	if revocation.revoked {
		evidence.OAuthRevoked = true
		evidence.OAuthRevocationStatus = "revoked"
		evidence.OAuthTokenType = firstString(revocation.tokenType, "refresh_token")
		return
	}
	if revocation.skipped {
		evidence.OAuthRevocationSkipped = true
		evidence.OAuthRevocationStatus = "skipped"
		evidence.OAuthRevocationSkipReason = strings.TrimSpace(revocation.reason)
		evidence.OAuthTokenType = firstString(revocation.tokenType, "refresh_token")
	}
}

func crmHubSpotCredentialCleanupStatus(revocation crmOAuthRevocationEvidence, hasCredentialRef bool) string {
	if revocation.revoked {
		return "managed_oauth_refresh_token_revoked_and_local_secret_delete_enforced"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_hubspot_private_app_token_if_no_longer_used"
}

func crmSalesforceCredentialCleanupStatus(revocation crmOAuthRevocationEvidence, hasCredentialRef bool) string {
	if revocation.revoked {
		return "managed_oauth_refresh_token_revoked_and_local_secret_delete_enforced"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_salesforce_credential_if_no_longer_used"
}

func crmPipedriveCredentialCleanupStatus(revocation crmOAuthRevocationEvidence, hasCredentialRef bool) string {
	if revocation.revoked {
		return "managed_oauth_refresh_token_revoked_and_local_secret_delete_enforced"
	}
	if revocation.skipped && strings.EqualFold(strings.TrimSpace(revocation.reason), "provider_uninstall_callback") {
		return "provider_uninstall_callback_local_managed_secret_delete_enforced"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_pipedrive_api_token_if_no_longer_used"
}

func crmZohoCredentialCleanupStatus(revocation crmOAuthRevocationEvidence, hasCredentialRef, storedCredentialRef bool) string {
	if revocation.revoked {
		if storedCredentialRef {
			return "managed_oauth_refresh_token_revoked_and_local_secret_delete_enforced"
		}
		return "managed_oauth_refresh_token_revoked"
	}
	if storedCredentialRef {
		return "local_managed_oauth_credential_delete_enforced_revoke_skipped"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_zoho_credential_if_no_longer_used"
}

func crmDynamics365CredentialCleanupStatus(hasCredentialRef, storedCredentialRef bool) string {
	if storedCredentialRef {
		return "local_managed_oauth_credential_delete_enforced_provider_revocation_unavailable"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_microsoft_oauth_credential_if_no_longer_used"
}

func crmKeapCredentialCleanupStatus(hasCredentialRef, storedCredentialRef bool) string {
	if storedCredentialRef {
		return "local_managed_oauth_or_api_key_credential_delete_enforced_provider_revocation_unavailable"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_keap_oauth_pat_or_sak_if_no_longer_used"
}

func crmHighLevelCredentialCleanupStatus(hasCredentialRef, storedCredentialRef bool) string {
	if storedCredentialRef {
		return "local_managed_oauth_credential_delete_enforced_provider_revocation_unavailable"
	}
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return "operator_revoke_or_rotate_highlevel_oauth_or_api_key_if_no_longer_used"
}

func crmOperatorCredentialCleanupStatus(hasCredentialRef bool, status string) string {
	if !hasCredentialRef {
		return "credentials_ref_missing"
	}
	return status
}

func crmPipedriveWebhookCleanupStatus(attempted bool, deletedIDs []string, settings map[string]any) string {
	if attempted {
		if len(deletedIDs) > 0 {
			return "postwave_deleted_managed_webhooks"
		}
		return "postwave_verified_no_matching_managed_webhooks"
	}
	if pipedriveManagedWebhooksPresent(settings) {
		return "postwave_cleanup_not_attempted_missing_credentials_or_registrar"
	}
	return "operator_review_duplicate_or_manual_webhooks"
}

func crmPipedriveWebhookIDs(settings map[string]any) []string {
	ids := hubSpotStringListSetting(settings, "pipedrive_webhook_ids")
	ids = append(ids, settingString(settings, "pipedrive_webhook_id"))
	return uniqueCRMStrings(ids)
}

func crmPipedriveDeletedWebhookIDs(summary PipedriveWebhookCleanupSummary) []string {
	ids := make([]string, 0, len(summary.Subscriptions))
	for _, sub := range summary.Subscriptions {
		if sub.Deleted {
			ids = append(ids, sub.ID)
		}
	}
	return uniqueCRMStrings(ids)
}
