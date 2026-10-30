// SPDX-License-Identifier: AGPL-3.0-only
//
// loyalty_ingest.go — native loyalty webhook inbound runtime.
//
// Some loyalty providers (Growave, Marsello, and any push-only program) expose
// NO bulk-list or export REST API — they only push events via webhooks. For
// those, the native integration is inbound: a public per-integration ingest URL
// carrying an opaque token resolves the owning tenant (before tenant context
// exists) via an RLS lookup policy, then a tolerant mapper turns the webhook
// body into canonical MemberInput (+ event) and lands it. Mirrors the Segment/
// RudderStack CDP ingest pattern (analytics_integrations) for the loyalty domain.
package loyalty_integrations

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

const loyaltyIngestMaxBodyBytes = 1 << 20

// LoyaltyIngestStore resolves a loyalty integration by its public ingest token.
type LoyaltyIngestStore interface {
	FindLoyaltyIntegrationByIngestToken(ctx context.Context, provider, token string) (*Integration, error)
}

// MountPublicRoutes registers the unauthenticated loyalty webhook ingest
// endpoint (per-integration token in the URL).
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/loyalty-integrations/smile/webhooks", d.SmileWebhook)
	r.Post("/api/public/loyalty-integrations/{provider}/ingest/{token}", d.LoyaltyWebhookIngest)
}

// LoyaltyWebhookIngest receives a provider loyalty webhook on a per-integration
// public URL, resolves the owning tenant by the URL token, verifies the optional
// shared secret, maps the body to a canonical member/event, and lands it.
func (d *Deps) LoyaltyWebhookIngest(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "loyalty ingest token is required")
		return
	}
	store, ok := d.Repo.(LoyaltyIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "loyalty ingest lookup is not configured")
		return
	}
	integration, err := store.FindLoyaltyIntegrationByIngestToken(r.Context(), provider, token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "loyalty integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if loyaltyIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "loyalty integration not found")
		return
	}
	if provider != "" && integration.Provider != provider {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "loyalty integration not found")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, loyaltyIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "loyalty payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := d.verifyLoyaltyWebhook(r, integration, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	current, err := d.currentLoyaltyIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "loyalty integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
	req, ok := mapLoyaltyWebhook(integration.Provider, body)
	if !ok {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	req = normalizeSyncRequest(req)
	current, err = d.currentLoyaltyIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "loyalty integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
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

// verifyLoyaltyWebhook validates the optional webhook signature. The
// per-integration URL token is the primary auth (unguessable); a configured
// webhook_secret_ref adds provider-specific signature verification where a
// verifier exists (e.g. LoyaltyLion base64 HMAC). An empty secret disables it.
func (d *Deps) verifyLoyaltyWebhook(r *http.Request, integration *Integration, body []byte) error {
	if d.WebhookSecrets == nil {
		return nil
	}
	ref := strings.TrimSpace(settingString(integration.Settings, "webhook_secret_ref"))
	if ref == "" {
		return nil
	}
	secret, err := d.WebhookSecrets.Get(r.Context(), ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return nil
	}
	switch integration.Provider {
	case ProviderLoyaltyLion:
		if !VerifyLoyaltyLionWebhookSignature(secret, body, r.Header.Get("X-Loyaltylion-Signature")) {
			return fmt.Errorf("loyaltylion webhook signature mismatch")
		}
	default:
		// No provider-specific verifier; the URL token is the auth.
	}
	return nil
}

// mapLoyaltyWebhook tolerantly turns a loyalty webhook body into a canonical
// member (points balance + VIP tier) and, when the payload names an event, a
// loyalty event. Field locations vary by provider, so it probes common paths.
func mapLoyaltyWebhook(provider string, body []byte) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		loyaltyWebhookString(raw, "email"),
		loyaltyWebhookString(raw, "customer_email"),
		loyaltyWebhookString(raw, "customer", "email"),
		loyaltyWebhookString(raw, "data", "email"),
		loyaltyWebhookString(raw, "data", "customer_email"),
		loyaltyWebhookString(raw, "data", "customer", "email"),
		// LoyaltyLion program_events nest the customer under payload.properties;
		// customers/update puts it at the root (covered above).
		loyaltyWebhookString(raw, "payload", "properties", "customer", "email"),
		loyaltyWebhookString(raw, "payload", "customer", "email"),
	)))
	if email == "" {
		return SyncRequest{}, false
	}
	points := loyaltyWebhookInt(raw,
		[]string{"points_balance"}, []string{"points"},
		[]string{"data", "points_balance"}, []string{"data", "points"},
		[]string{"customer", "points_balance"},
		// Growave (root camelCase) + LoyaltyLion (payload.properties.customer).
		[]string{"currentBalance"},
		[]string{"customer", "points_approved"},
		[]string{"payload", "properties", "customer", "points_balance"},
		[]string{"payload", "properties", "customer", "points_approved"},
	)
	tier := strings.TrimSpace(firstString(
		loyaltyWebhookString(raw, "vip_tier", "name"),
		loyaltyWebhookString(raw, "vip_tier"),
		loyaltyWebhookString(raw, "tier", "name"),
		loyaltyWebhookString(raw, "tier"),
		loyaltyWebhookString(raw, "vip_tier_name"),
		loyaltyWebhookString(raw, "data", "tier"),
		loyaltyWebhookString(raw, "data", "vip_tier_name"),
		// LoyaltyLion nested tier membership.
		loyaltyWebhookString(raw, "payload", "properties", "customer", "loyalty_tier_membership", "loyalty_tier", "name"),
	))
	event := strings.TrimSpace(firstString(
		loyaltyWebhookString(raw, "event"),
		loyaltyWebhookString(raw, "topic"),
		loyaltyWebhookString(raw, "type"),
		loyaltyWebhookString(raw, "event_name"),
	))
	member := MemberInput{
		SourceID:      provider + "://webhook/" + email,
		Email:         email,
		PointsBalance: points,
		VIPTier:       tier,
		FirstName:     loyaltyWebhookString(raw, "customer", "first_name"),
		LastName:      loyaltyWebhookString(raw, "customer", "last_name"),
	}
	out := SyncRequest{RunMode: "webhook", Members: []MemberInput{member}}
	if event != "" {
		out.Events = []LoyaltyEventInput{{
			SourceID:  provider + "://event/" + email,
			Email:     email,
			EventName: event,
			Points:    points,
			VIPTier:   tier,
		}}
	}
	return out, true
}

func loyaltyWebhookString(node map[string]any, path ...string) string {
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

func loyaltyWebhookInt(node map[string]any, paths ...[]string) int {
	for _, path := range paths {
		cur := any(node)
		ok := true
		for i, key := range path {
			m, isMap := cur.(map[string]any)
			if !isMap {
				ok = false
				break
			}
			v, present := m[key]
			if !present || v == nil {
				ok = false
				break
			}
			if i == len(path)-1 {
				switch typed := v.(type) {
				case float64:
					return int(typed)
				case int:
					return typed
				case json.Number:
					if n, err := typed.Int64(); err == nil {
						return int(n)
					}
				}
				ok = false
				break
			}
			cur = v
		}
		_ = ok
	}
	return 0
}
