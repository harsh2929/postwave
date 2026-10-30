// SPDX-License-Identifier: AGPL-3.0-only
//
// support_ingest.go — Route41 support-provider ingress hold plus archived
// adapter fixtures.
//
// Production mounts only the method-agnostic family hold below. Historical
// provider adapters remain reachable solely through the package-private test
// fixture so their mapping/signature algorithms retain coverage without
// reviving URL-token lookup, provider callbacks, or customer-content writes.
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const supportIngestMaxBodyBytes = 1 << 20

var ErrMissingSupportWebhookSecret = errors.New("support webhook secret is required")

// SupportIngestStore resolves a support integration by its public ingest token.
type SupportIngestStore interface {
	FindSupportIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error)
}

// MountPublicRoutes installs one method-agnostic hold for the entire public
// support-provider family. A wildcard is intentional: wrong methods, malformed
// historical paths, and future descendants must reach the same zero-read,
// zero-side-effect privacy boundary instead of a raw-path 404/405.
func MountPublicRoutes(r chi.Router, d *Deps) {
	_ = d
	held := http.HandlerFunc(SupportProviderIngressHeld)
	r.Handle("/api/public/support-integrations", held)
	r.Handle("/api/public/support-integrations/*", held)
}

// mountArchivedPublicRoutesFixture preserves provider adapter tests without
// making their routes reachable from production composition.
func mountArchivedPublicRoutesFixture(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	archive := withArchivedSupportRuntimeFixture
	r.With(archive).Post("/api/public/support-integrations/zendesk/{subdomain}/webhooks", d.ZendeskWebhook)
	r.With(archive).Post("/api/public/support-integrations/intercom/{workspace_id}/webhooks", d.IntercomWebhook)
	r.With(archive).Post("/api/public/support-integrations/gorgias/{account_domain}/webhooks", d.GorgiasWebhook)
	r.With(archive).Post("/api/public/support-integrations/freshdesk/{account_domain}/webhooks", d.FreshdeskWebhook)
	r.With(archive).Post("/api/public/support-integrations/freshchat/{account_domain}/webhooks", d.FreshchatWebhook)
	r.With(archive).Post("/api/public/support-integrations/freshchat/{account_domain}/webhooks/{webhook_id}", d.FreshchatWebhook)
	r.With(archive).Post("/api/public/support-integrations/tidio/{project_public_key}/webhooks", d.TidioWebhook)
	r.With(archive).Post("/api/public/support-integrations/tidio/{project_public_key}/webhooks/{webhook_id}", d.TidioWebhook)
	r.With(archive).Post("/api/public/support-integrations/ada/{ai_agent_domain}/webhooks", d.AdaWebhook)
	r.With(archive).Post("/api/public/support-integrations/ada/{ai_agent_domain}/webhooks/{webhook_id}", d.AdaWebhook)
	r.With(archive).Post("/api/public/support-integrations/gladly/{organization_domain}/webhooks", d.GladlyWebhook)
	r.With(archive).Post("/api/public/support-integrations/gladly/{organization_domain}/webhooks/{webhook_id}", d.GladlyWebhook)
	r.With(archive).Post("/api/public/support-integrations/groove/{mailbox_id}/webhooks/{webhook_id}", d.GrooveWebhook)
	r.With(archive).Post("/api/public/support-integrations/reamaze/{account_domain}/webhooks/{webhook_id}", d.ReamazeWebhook)
	r.With(archive).Post("/api/public/support-integrations/helpcrunch/{organization_id}/webhooks", d.HelpCrunchWebhook)
	r.With(archive).Post("/api/public/support-integrations/helpcrunch/{organization_id}/webhooks/{webhook_id}", d.HelpCrunchWebhook)
	r.With(archive).Post("/api/public/support-integrations/jira-service-management/{site_id}/webhooks/{webhook_id}", d.JiraServiceManagementWebhook)
	r.With(archive).Post("/api/public/support-integrations/linear/{workspace_id}/webhooks/{webhook_id}", d.LinearWebhook)
	r.With(archive).Post("/api/public/support-integrations/asana-support/{workspace_id}/webhooks/{webhook_id}", d.AsanaSupportWebhook)
	r.With(archive).Post("/api/public/support-integrations/clickup-support/{workspace_id}/webhooks/{webhook_id}", d.ClickUpSupportWebhook)
	r.With(archive).Post("/api/public/support-integrations/help-scout/{mailbox_id}/webhooks", d.HelpScoutWebhook)
	r.With(archive).Post("/api/public/support-integrations/front/{inbox_id}/webhooks", d.FrontWebhook)
	r.With(archive).Post("/api/public/support-integrations/crisp/{website_id}/webhooks", d.CrispWebhook)
	r.With(archive).Post("/api/public/support-integrations/kustomer/{organization_id}/webhooks", d.KustomerWebhook)
	r.With(archive).Post("/api/public/support-integrations/drift/{workspace_id}/webhooks", d.DriftWebhook)
	r.With(archive).Post("/api/public/support-integrations/livechat/{account_id}/webhooks", d.LiveChatWebhook)
	r.With(archive).Post("/api/public/support-integrations/olark/{site_id}/webhooks", d.OlarkWebhook)
	r.With(archive).Post("/api/public/support-integrations/olark/{site_id}/webhooks/{webhook_id}", d.OlarkWebhook)
	r.With(archive).Post("/api/public/support-integrations/kayako/{account_domain}/webhooks", d.KayakoWebhook)
	r.With(archive).Post("/api/public/support-integrations/kayako/{account_domain}/webhooks/{webhook_id}", d.KayakoWebhook)
	r.With(archive).Post("/api/public/support-integrations/hubspot-service-hub/webhooks", d.HubSpotServiceHubWebhook)
	r.With(archive).Post("/api/public/support-integrations/hubspot-service-hub/{portal_id}/webhooks", d.HubSpotServiceHubWebhook)
	r.With(archive).Post("/api/public/support-integrations/salesforce-service-cloud/{instance_url}/webhooks", d.SalesforceServiceCloudWebhook)
	r.With(archive).Post("/api/public/support-integrations/zoho-desk/{organization_id}/webhooks", d.ZohoDeskWebhook)
	r.With(archive).Post("/api/public/support-integrations/{provider}/ingest/{token}", d.archivedSupportWebhookIngestFixture)
}

func SupportProviderIngressHeld(w http.ResponseWriter, r *http.Request) {
	if r != nil && r.URL != nil {
		r.URL.Path = "/api/public/support-integrations/[REDACTED]"
		r.URL.RawPath = ""
		r.URL.RawQuery = ""
	}
	writeSupportReleaseHold(w, "support_provider_ingress_held", "Support-provider ingestion is release-held until tenant authority, replay, privacy lifecycle, and immutable evidence are certified together.")
}

// SupportWebhookIngest receives a provider support webhook on a per-integration
// public URL, resolves the owning tenant by the URL token, verifies the optional
// secret, maps the body to a canonical ticket, and lands it.
func (d *Deps) SupportWebhookIngest(w http.ResponseWriter, r *http.Request) {
	// A secret in the URL is a routing token, not sufficient authentication for
	// raw customer-content ingestion. Keep this generic fallback structurally
	// held until non-URL HMAC verification, replay-window/nonce enforcement,
	// edge-log redaction, durable audit, and governed lifecycle ship together.
	// Mutate the request path before outer after-response loggers inspect it so
	// the bearer token is not copied into ordinary access-log fields.
	if r != nil && r.URL != nil {
		r.URL.Path = "/api/public/support-integrations/[provider]/ingest/[REDACTED]"
		r.URL.RawPath = ""
	}
	writeSupportReleaseHold(w, "support_ingest_release_held", "Generic support webhook ingest is release-held until its credential, replay, audit, and privacy lifecycle are certified.")
}

func (d *Deps) archivedSupportWebhookIngestFixture(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "support ingest token is required")
		return
	}
	store, ok := d.Repo.(SupportIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "support ingest lookup is not configured")
		return
	}
	integration, err := store.FindSupportIntegrationByIngestToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "support integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if provider != "" && integration.Provider != provider {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "support integration not found")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "support payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := d.verifySupportWebhook(r, integration, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	req, ok := mapSupportWebhook(integration.Provider, body)
	if !ok {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

func writeSupportReleaseHold(w http.ResponseWriter, code, message string) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// verifySupportWebhook validates the optional webhook secret. The per-integration
// URL token is the primary auth (unguessable); a configured webhook_secret_ref
// adds a shared-secret header compare. An empty secret disables verification.
func (d *Deps) verifySupportWebhook(r *http.Request, integration *Integration, _ []byte) error {
	ref := strings.TrimSpace(settingString(integration.Settings, "webhook_secret_ref"))
	if ref == "" {
		return nil
	}
	if d.WebhookSecrets == nil {
		return ErrMissingSupportWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(r.Context(), ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return ErrMissingSupportWebhookSecret
	}
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(got, "Bearer "); found {
		got = strings.TrimSpace(rest)
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Webhook-Secret"))
	}
	if got != strings.TrimSpace(secret) {
		return fmt.Errorf("support webhook secret mismatch")
	}
	return nil
}

// mapSupportWebhook tolerantly turns a support webhook body into a canonical
// ticket. Field locations vary by provider, so it probes common paths.
func mapSupportWebhook(provider string, body []byte) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		supportWebhookString(raw, "email"),
		supportWebhookString(raw, "customer_email"),
		supportWebhookString(raw, "customer", "email"),
		supportWebhookString(raw, "contact", "email"),
		supportWebhookString(raw, "data", "email"),
		supportWebhookString(raw, "data", "customer", "email"),
		supportWebhookString(raw, "user", "email"),
		// Tidio nests every event under a top-level "content" envelope; the email
		// field name varies by family (contact.email vs ticket.contact_email).
		supportWebhookString(raw, "content", "email"),
		supportWebhookString(raw, "content", "contact_email"),
	)))
	if email == "" {
		// Freshchat webhooks carry no email (only a user_id UUID) — landing a
		// ticket needs a GET /v2/users/{id} enrichment hop, out of scope for the
		// tolerant mapper, so such payloads are correctly ignored.
		return SyncRequest{}, false
	}
	convID := strings.TrimSpace(firstString(
		supportWebhookString(raw, "conversation", "id"),
		supportWebhookString(raw, "conversation_id"),
		supportWebhookString(raw, "ticket", "id"),
		supportWebhookString(raw, "data", "id"),
		supportWebhookString(raw, "id"),
		// Tidio (contact_id; no conversation-id field) + Freshchat (nested).
		supportWebhookString(raw, "content", "id"),
		supportWebhookString(raw, "content", "contact_id"),
		supportWebhookString(raw, "data", "message", "conversation_id"),
	))
	subject := strings.TrimSpace(firstString(
		supportWebhookString(raw, "subject"),
		supportWebhookString(raw, "conversation", "subject"),
		supportWebhookString(raw, "title"),
		supportWebhookString(raw, "data", "subject"),
		supportWebhookString(raw, "content", "subject"),
	))
	status := strings.TrimSpace(firstString(
		supportWebhookString(raw, "status"),
		supportWebhookString(raw, "state"),
		supportWebhookString(raw, "conversation", "status"),
		supportWebhookString(raw, "data", "status"),
		supportWebhookString(raw, "content", "status"),
	))
	event := strings.TrimSpace(firstString(
		supportWebhookString(raw, "event"),
		supportWebhookString(raw, "topic"),
		supportWebhookString(raw, "type"),
		// Freshchat uses "action"; Tidio/others use "topic" (covered above).
		supportWebhookString(raw, "action"),
	))
	id := firstString(convID, email)
	ticket := TicketInput{
		SourceID:       provider + "://ticket/" + id,
		ConversationID: convID,
		Email:          email,
		Subject:        subject,
		Status:         status,
		Properties:     map[string]any{provider + "_event": event},
	}
	return SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}}, true
}

func supportWebhookString(node map[string]any, path ...string) string {
	cur := any(node)
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		v, ok := m[key]
		if !ok || v == nil {
			return ""
		}
		if i == len(path)-1 {
			switch typed := v.(type) {
			case string:
				return strings.TrimSpace(typed)
			case float64:
				return strings.TrimSpace(fmt.Sprint(typed))
			default:
				return ""
			}
		}
		cur = v
	}
	return ""
}
