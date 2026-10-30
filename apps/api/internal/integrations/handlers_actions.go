// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Lifecycle action facade: the connect/sync/pause/resume/disconnect routes and
// the delegated owning-endpoint resolution per integration surface.

func (h *handler) action(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimSpace(chi.URLParam(r, "slug"))
		item, ok := h.catalogItemBySlugForRequest(r.Context(), slug)
		if !ok {
			writeError(w, http.StatusNotFound, "integration_not_found", "integration not found")
			return
		}

		conn := connectionFromItem(item)
		if h.pool != nil {
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok || tenant.ID == "" {
				writeError(w, http.StatusUnauthorized, "tenant_required", "tenant context is required")
				return
			}
			tx, err := db.WithTenant(r.Context(), h.pool, tenant.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "tenant_tx_failed", "could not open tenant-scoped transaction")
				return
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			connections := map[string]Connection{item.Slug: conn}
			h.applyRuntimeStatus(r, tx, connections)
			h.applyRuntimeConnectionIDs(r.Context(), tx, connections)
			conn = connections[item.Slug]
		}

		resp, code := lifecycleAction(item, action)
		resp = actionResponseWithConnection(resp, conn)
		writeJSON(w, code, resp)
	}
}

func lifecycleAction(item CatalogItem, action string) (actionResponse, int) {
	resp := actionResponse{
		Slug:       item.Slug,
		Action:     action,
		DocsURL:    item.DocsURL,
		ManagePath: item.SetupPath,
	}
	if item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned {
		resp.Status = "unavailable"
		resp.Message = fmt.Sprintf("%s is a %s roadmap preview and exposes no connection lifecycle. Choose an integration whose runtime_status is available or partial.", item.Name, phaseLabel(item.Phase))
		return resp, http.StatusConflict
	}

	resp.Status = "delegated"
	resp.Message = fmt.Sprintf("%s is managed through the existing Moosewave surface.", item.Name)
	resp.DelegatedTo = delegatedEndpoint(item, action)
	if isKlaviyoNativeSurface(item) {
		resp.Message = "Klaviyo native provider-row lifecycle is attached with credential-ref-only setup, managed public-app OAuth install/refresh/revoke, signed system-webhook receipt, managed Webhooks API subscription reconciliation for allowlisted credentials, durable run history, native JSON:API profile/list/segment/source-event pulls, versioned klaviyo_native cursors, scheduled provider-row polling, existing-profile writeback for properties, list adds, and custom events, and local provider-cleanup acknowledgement; OAuth live certification, Webhooks API live allowlist certification, writeback live certification, and live certification remain open."
		switch action {
		case "connect/start":
			resp.RequiredFields = []string{"credentials_ref"}
			resp.DelegatedTo = "POST /api/v1/marketing-integrations"
			resp.Message = "Create the Klaviyo native provider row with a credential reference. Raw private API keys are rejected from settings; native JSON:API profile/source-event pulls hydrate the key through the shared secret resolver."
		case "sync":
			resp.RequiredFields = []string{"id"}
			resp.DelegatedTo = "POST /api/v1/marketing-integrations/{id}/sync"
			resp.Message = "Run a Klaviyo native changed-profile source-event pull against the provider row and record completed or failed marketing_sync_runs with a versioned klaviyo_native cursor."
		case "backfill":
			resp.RequiredFields = []string{"id"}
			resp.DelegatedTo = "POST /api/v1/marketing-integrations/{id}/backfill"
			resp.Message = "Run a Klaviyo native profile backfill page plus list/segment discovery against the provider row and record marketing_sync_runs with a versioned klaviyo_native cursor."
		case "pause":
			resp.RequiredFields = []string{"id"}
			resp.DelegatedTo = "POST /api/v1/marketing-integrations/{id}/pause"
			resp.Message = "Pause the Klaviyo native provider row while preserving provider settings, sync history, and native cursor evidence."
		case "disconnect":
			resp.RequiredFields = []string{"id"}
			resp.DelegatedTo = "DELETE /api/v1/marketing-integrations/{id}"
			resp.Message = "Mark the Klaviyo native provider row disconnected, preserve run/webhook/audit history, persist provider-cleanup guidance, delete managed OAuth credential envelopes, and revoke managed OAuth tokens when present. Klaviyo API-key revocation, duplicate/manual webhook audits, and provider-side writeback cleanup remain provider-console actions."
		case "provider-cleanup/acknowledge":
			resp.RequiredFields = []string{"id", "completed_actions|notes"}
			resp.DelegatedTo = "POST /api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge"
			resp.Message = "Record local operator attestation against persisted Klaviyo provider_cleanup evidence after private-key, duplicate-webhook, and writeback cleanup review is complete. This does not call Klaviyo APIs or claim provider-side cleanup automation."
		}
		return resp, http.StatusAccepted
	}
	if isKlaviyoMigrationSurface(item) {
		resp.Message = "Klaviyo is an API-backed migration-to-live source, not a managed native provider connector. Moosewave delegates setup, backfill, and source-event monitoring to the migration runtime."
		switch action {
		case "connect/start":
			resp.RequiredFields = []string{"api_key"}
			resp.DelegatedTo = "POST /api/v1/migrations/klaviyo/credentials"
			resp.Message = "Create a Klaviyo API-key migration job. The adapter validates /accounts, sends Klaviyo-API-Key auth, and pins the Klaviyo API revision header."
		case "sync":
			resp.RequiredFields = []string{"job_id", "interval_seconds"}
			resp.DelegatedTo = "POST /api/v1/migrations/sources/klaviyo/source-events"
			resp.Message = "Start or refresh the Klaviyo source-event monitor for changed profiles using updated-time filters and JSON:API page cursors."
		case "backfill":
			resp.RequiredFields = []string{"job_id"}
			resp.DelegatedTo = "POST /api/v1/migrations/klaviyo/dry-run then POST /api/v1/migrations/klaviyo/commit"
			resp.Message = "Backfill Klaviyo profiles, lists, segments, flows, campaigns, templates, and source-archive rebuild tasks through the migration dry-run and commit flow."
		case "pause":
			resp.RequiredFields = []string{"job_id"}
			resp.DelegatedTo = "DELETE /api/v1/migrations/{job_id}/source-events"
			resp.Message = "Pause Klaviyo migration-to-live polling by disabling the source-event monitor for the migration job."
		case "disconnect":
			resp.RequiredFields = []string{"job_id"}
			resp.DelegatedTo = "DELETE /api/v1/migrations/{job_id}/source-events and DELETE /api/v1/migrations/{job_id}"
			resp.Message = "Stop Klaviyo source-event monitoring or cancel the migration job in Moosewave. Provider-side API-key revocation and webhook/OAuth cleanup remain Klaviyo account actions."
		}
		return resp, http.StatusAccepted
	}
	if item.Badge == BadgePartner && hasSource(item, "developer_marketplace") {
		resp.Message = fmt.Sprintf("%s is installed and monitored through the Developer Marketplace OAuth app runtime.", item.Name)
		switch action {
		case "connect/start":
			resp.RequiredFields = []string{"client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"}
			resp.Message = "Start the reviewed partner app OAuth install flow."
		case "connect/callback":
			resp.RequiredFields = []string{"code", "redirect_uri", "client_id", "client_secret", "code_verifier"}
			resp.Message = "Exchange the partner app authorization code for a scoped marketplace access token."
		case "sync", "backfill":
			resp.Message = "Partner app sync/backfill is monitored through the marketplace app monitoring report."
		case "pause", "disconnect":
			resp.RequiredFields = []string{"installation_id"}
			resp.Message = "Revoke the tenant's marketplace app installation to stop partner access."
		}
		return resp, http.StatusAccepted
	}
	if item.Badge == BadgeNative {
		if hasSource(item, "sending") {
			resp.Message = fmt.Sprintf("%s is a partial/delegated email-sending foundation. Moosewave owns parts of provisioning, send-loop routing, and deliverability ingestion; direct provider send APIs and official provider webhook verification are not fully verified for this tile yet.", item.Name)
			switch action {
			case "connect/start", "connect/callback":
				resp.RequiredFields = sendingRequiredFields(item)
				resp.Message = "Record the sending-provider setup on the owning deliverability, mailer, or Listmonk messenger surface. Direct provider API keys are not accepted by this facade."
			case "sync", "backfill":
				resp.RequiredFields = []string{"campaign_id_or_provider_event_payload"}
				resp.Message = "Email sending does not run historical sync here. Campaign sends route through the Moosewave send loop/Listmonk messenger; provider events arrive through deliverability webhooks."
			case "pause":
				resp.RequiredFields = []string{"provider_config_id_or_sending_profile"}
				resp.Message = "Pause the Moosewave sending/provider configuration. Also pause provider-side sender, domain, webhook, or SMTP credentials in the provider console when needed."
			case "disconnect":
				resp.RequiredFields = []string{"provider_config_id_or_sending_profile"}
				resp.Message = "Delete or pause the Moosewave provider configuration. Provider-side sender, domain, API key, SNS topic, webhook, or SMTP cleanup remains operator-managed."
			}
			return resp, http.StatusAccepted
		}
		if hasSource(item, "sms") {
			resp.Message = fmt.Sprintf("%s is release-held. Live sends, A2P effects, hosted multi-tenant callbacks and end-to-end MMS are unavailable until durable reconciliation, financial settlement and tenant-bound provider credential ownership are deployed.", item.Name)
			switch action {
			case "connect/start", "connect/callback":
				resp.RequiredFields = []string{"provider", "phone_number_or_sender_container", "registration_status"}
				resp.Message = "Record an SMS sender profile and provider registration identifiers after provider-side app/profile setup and carrier registration evidence are complete."
			case "sync", "backfill":
				resp.RequiredFields = []string{"sender_profile_id", "list_id", "campaign_or_test_send_payload"}
				resp.Message = "SMS provider sync and effect operations are release-held; no campaign/test send, A2P polling, or hosted callback readiness is advertised."
			case "pause":
				resp.RequiredFields = []string{"sender_profile_id"}
				resp.Message = "Pause the Moosewave sender profile. Also pause or disable provider-side apps/profiles in the provider console when needed."
			case "disconnect":
				resp.RequiredFields = []string{"sender_profile_id"}
				resp.Message = "Pause/remove the Moosewave sender profile. Provider-side app, number, campaign, or messaging-profile cleanup remains operator-managed."
			}
			return resp, http.StatusAccepted
		}
		if meta, ok := managedProviderMetadataForItem(item); ok {
			resp = decorateManagedProviderLifecycleResponse(resp, meta, action)
			return resp, http.StatusAccepted
		}
	}
	switch item.Slug {
	case "shopify":
		if action == "connect/start" {
			resp.RequiredFields = []string{"shop_domain"}
			resp.DelegatedTo = "GET /api/v1/commerce/shopify/oauth/start?shop={shop_domain}"
			resp.Message = "Start Shopify OAuth through the commerce OAuth endpoint."
		}
	case "outbound-webhooks":
		resp.RequiredFields = []string{"url", "events"}
	case "inbound-webhooks":
		resp.RequiredFields = []string{"name"}
	case "zapier", "make", "n8n", "pipedream":
		resp.Message = "Use API keys plus inbound or outbound webhooks for this bridge recipe."
	}
	return resp, http.StatusAccepted
}

func delegatedEndpoint(item CatalogItem, action string) string {
	switch {
	case hasSource(item, "support_integration"):
		return ""
	case isMarketingNativeSurface(item):
		switch action {
		case "sync":
			return "POST /api/v1/marketing-integrations/{id}/sync"
		case "pause":
			return "POST /api/v1/marketing-integrations/{id}/pause"
		case "disconnect":
			return "DELETE /api/v1/marketing-integrations/{id}"
		case "backfill":
			return "POST /api/v1/marketing-integrations/{id}/backfill"
		default:
			return "POST /api/v1/marketing-integrations"
		}
	case isKlaviyoMigrationSurface(item):
		switch action {
		case "sync":
			return "POST /api/v1/migrations/sources/klaviyo/source-events"
		case "pause":
			return "DELETE /api/v1/migrations/{job_id}/source-events"
		case "disconnect":
			return "DELETE /api/v1/migrations/{job_id}/source-events and DELETE /api/v1/migrations/{job_id}"
		case "backfill":
			return "POST /api/v1/migrations/klaviyo/dry-run then POST /api/v1/migrations/klaviyo/commit"
		default:
			return "POST /api/v1/migrations/klaviyo/credentials"
		}
	case hasSource(item, "commerce"):
		return commerceEndpointFor(action)
	case hasSource(item, "crm"):
		return managedEndpointFor("/api/v1/crm/integrations", action)
	case hasSource(item, "lead_capture"):
		return managedEndpointFor("/api/v1/lead-integrations", action)
	case hasSource(item, "review_integration"):
		return managedEndpointFor("/api/v1/review-integrations", action)
	case hasSource(item, "loyalty_integration"):
		return managedEndpointFor("/api/v1/loyalty-integrations", action)
	case hasSource(item, "subscription_integration"):
		return managedEndpointFor("/api/v1/subscription-integrations", action)
	case hasSource(item, "analytics_integration"):
		return managedEndpointFor("/api/v1/analytics-integrations", action)
	case hasSource(item, "audience_destination"):
		return audienceDestinationEndpointFor(action)
	case hasSource(item, "warehouse"):
		return warehouseEndpointFor(action)
	case hasSource(item, "sending"):
		return sendingEndpointFor(item, action)
	case hasSource(item, "outbound_webhooks"):
		return "POST /api/v1/outbound-webhooks"
	case hasSource(item, "inbound_webhooks"):
		return "POST /api/v1/inbound-webhooks/endpoints"
	case hasSource(item, "developer_marketplace"):
		return developerMarketplaceEndpointFor(item, action)
	case hasSource(item, "mcp"):
		// The catalog entry is release-held and has no connection lifecycle.
		// Do not advertise the nonexistent historical manifest endpoint.
		return ""
	case hasSource(item, "slack"):
		return "GET /api/v1/slack/oauth/start"
	case hasSource(item, "discord"):
		return "POST /api/v1/discord/integrations"
	case hasSource(item, "teams"):
		return "POST /api/v1/teams/integrations"
	case hasSource(item, "sms"):
		switch action {
		case "connect/start", "connect/callback":
			return "POST /api/v1/sms/senders and /api/v1/sms/senders/{id}/a2p/*"
		case "sync", "backfill":
			return "POST /api/v1/sms/campaigns/{id}/send or POST /api/v1/sms/test-send"
		case "pause":
			return "POST /api/v1/sms/senders/{id}/pause"
		case "disconnect":
			return "POST /api/v1/sms/senders/{id}/pause plus provider-console cleanup"
		default:
			return "GET /api/v1/sms/setup"
		}
	case hasSource(item, "migration"):
		return "POST /api/v1/migrations"
	case hasSource(item, "zapier_package") || hasSource(item, "bridge"):
		return "POST /api/v1/inbound-webhooks/endpoints or POST /api/v1/outbound-webhooks"
	default:
		if action == "disconnect" {
			return "DELETE on the owning integration surface"
		}
		return "owning integration surface"
	}
}

func developerMarketplaceEndpointFor(item CatalogItem, action string) string {
	if item.Badge == BadgePartner || hasSource(item, "oauth_app") || hasSource(item, "app_listing") {
		switch action {
		case "connect/start":
			return "POST /api/v1/developer-marketplace/oauth/authorize"
		case "connect/callback":
			return "POST /api/v1/developer-marketplace/oauth/token"
		case "sync", "backfill":
			return "GET /api/v1/developer-marketplace/apps/{id}/monitoring"
		case "pause", "disconnect":
			return "DELETE /api/v1/developer-marketplace/installations/{installation_id}"
		default:
			return "GET /api/v1/developer-marketplace/apps/{id}/monitoring"
		}
	}
	switch action {
	case "sync", "backfill":
		return "GET /api/v1/developer-marketplace/apps/{id}/monitoring"
	case "pause", "disconnect":
		return "DELETE /api/v1/developer-marketplace/installations/{installation_id}"
	default:
		return "POST /api/v1/developer-marketplace/apps"
	}
}

func sendingRequiredFields(item CatalogItem) []string {
	switch item.Slug {
	case "postmark":
		return []string{"postmark_account_token_env", "server_id_or_message_stream_id", "server_token_ref"}
	case "ses":
		return []string{"aws_region", "configuration_set", "sns_topic_arn"}
	case "sendgrid":
		return []string{"event_webhook_public_key_or_edge_token", "webhook_events"}
	case "mailgun":
		return []string{"domain", "webhook_signing_key_or_edge_token"}
	case "smtp":
		return []string{"listmonk_messenger_name", "operator_managed_smtp_credentials"}
	default:
		return []string{"provider", "credential_ref_or_webhook_token"}
	}
}

func sendingEndpointFor(item CatalogItem, action string) string {
	switch item.Slug {
	case "postmark":
		switch action {
		case "connect/start", "connect/callback":
			return "POST /api/v1/sending/provision or POST /api/v1/deliverability/providers"
		case "sync", "backfill":
			return "send loop via Listmonk /api/tx; direct Postmark /email driver pending"
		case "pause", "disconnect":
			return "sending_state cleanup plus DELETE /api/v1/deliverability/providers/{id}"
		}
	case "ses":
		switch action {
		case "connect/start", "connect/callback":
			return "POST /api/v1/deliverability/providers plus AWS SES/SNS operator setup"
		case "sync", "backfill":
			return "SES transactional mailer and SNS deliverability webhooks; campaign driver pending"
		case "pause", "disconnect":
			return "DELETE /api/v1/deliverability/providers/{id} plus AWS console cleanup"
		}
	case "sendgrid", "mailgun":
		switch action {
		case "connect/start", "connect/callback":
			return "POST /api/v1/deliverability/providers"
		case "sync", "backfill":
			return "POST /api/v1/deliverability/" + item.Slug + " webhook ingest; direct send API driver pending"
		case "pause", "disconnect":
			return "DELETE /api/v1/deliverability/providers/{id} plus provider-console cleanup"
		}
	case "smtp":
		switch action {
		case "connect/start", "connect/callback":
			return "Listmonk messenger/operator SMTP configuration"
		case "sync", "backfill":
			return "send loop via Listmonk /api/tx"
		case "pause", "disconnect":
			return "Listmonk messenger/operator SMTP cleanup"
		}
	}
	return "GET /sending and /api/v1/deliverability/providers"
}

func managedEndpointFor(basePath, action string) string {
	switch action {
	case "sync":
		return "POST " + basePath + "/{id}/sync"
	case "backfill":
		return "POST " + basePath + "/{id}/backfill"
	case "pause":
		return "POST " + basePath + "/{id}/pause"
	case "disconnect":
		return "DELETE " + basePath + "/{id}"
	case "connect/callback":
		return "POST " + basePath
	default:
		return "POST " + basePath
	}
}

func commerceEndpointFor(action string) string {
	switch action {
	case "sync":
		return "POST /api/v1/commerce/integrations/{id}/sync"
	case "backfill":
		return "POST /api/v1/commerce/integrations/{id}/backfill"
	case "pause":
		return "Commerce integration settings"
	case "disconnect":
		return "Commerce integration settings and data-delete workflow"
	default:
		return "POST /api/v1/commerce/integrations"
	}
}

func warehouseEndpointFor(action string) string {
	switch action {
	case "sync", "backfill":
		return "POST /api/v1/warehouse/connections/{id}/runs"
	case "pause":
		return "POST /api/v1/warehouse/connections/{id}/pause"
	case "disconnect":
		return "DELETE /api/v1/warehouse/connections/{id}"
	default:
		return "POST /api/v1/warehouse/connections"
	}
}

func audienceDestinationEndpointFor(action string) string {
	switch action {
	case "sync", "backfill":
		return "POST /api/v1/audience-destinations/{id}/sync"
	case "pause":
		return "PATCH /api/v1/audience-destinations/{id}"
	case "disconnect":
		return "DELETE /api/v1/audience-destinations/{id}"
	default:
		return "POST /api/v1/audience-destinations"
	}
}
