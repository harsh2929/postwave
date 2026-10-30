// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics_webhook_ingest.go — GENERIC analytics webhook ingest. payments,
// events (webinars), cms, and any other "profile + event" SaaS tool land as a
// person + an event — exactly what analytics_integrations already models. Rather
// than a new subsystem per category, a single generic path resolves the tenant
// by an analytics_ingest_token (migration 1617) and maps any webhook body to a
// canonical profile/event. Sits alongside the CDP-specific Segment/RudderStack
// ingest; chi routes the static segment/rudderstack paths to their handlers and
// every other {provider} to this one.
package analytics_integrations

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

const analyticsGenericIngestMaxBodyBytes = 1 << 20

// AnalyticsIngestStore resolves a generic analytics integration by its token.
type AnalyticsIngestStore interface {
	FindAnalyticsIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error)
}

// AnalyticsWebhookIngest receives a webhook from any non-CDP analytics provider
// on a per-integration public URL, resolves the owning tenant by the URL token,
// verifies the optional shared secret, maps the body to a canonical
// profile/event, and lands it.
func (d *Deps) AnalyticsWebhookIngest(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "analytics ingest token is required")
		return
	}
	store, ok := d.Repo.(AnalyticsIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "analytics ingest lookup is not configured")
		return
	}
	integration, err := store.FindAnalyticsIntegrationByIngestToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "analytics integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, analyticsGenericIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "analytics payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := VerifySegmentSignature(d.segmentSharedSecret(r.Context(), integration), body, r.Header.Get("X-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	req, ok := mapGenericAnalyticsWebhook(body)
	if !ok {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	req = normalizeSyncRequest(req)
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

// mapGenericAnalyticsWebhook turns an arbitrary provider webhook into a canonical
// profile + event. It first honors the Segment identify/track spec (many tools
// emit it), then falls back to a tolerant probe across common email/event paths.
// No email -> no-op (so anonymous/malformed bodies can't land cross-tenant data).
func mapGenericAnalyticsWebhook(body []byte) (SyncRequest, bool) {
	if req, ok := mapCDPEvent(body, "webhook"); ok {
		return req, true
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		analyticsWebhookString(raw, "email"),
		analyticsWebhookString(raw, "customer_email"),
		analyticsWebhookString(raw, "customer", "email"),
		analyticsWebhookString(raw, "contact", "email"),
		analyticsWebhookString(raw, "user", "email"),
		analyticsWebhookString(raw, "data", "email"),
		analyticsWebhookString(raw, "data", "customer", "email"),
		analyticsWebhookString(raw, "data", "object", "email"),
		analyticsWebhookString(raw, "properties", "email"),
		analyticsWebhookString(raw, "content", "email"),
		analyticsWebhookString(raw, "payload", "email"),
	)))
	if email == "" {
		return SyncRequest{}, false
	}
	event := strings.TrimSpace(firstString(
		analyticsWebhookString(raw, "event"),
		analyticsWebhookString(raw, "event_name"),
		analyticsWebhookString(raw, "type"),
		analyticsWebhookString(raw, "topic"),
		analyticsWebhookString(raw, "action"),
	))
	if event == "" {
		event = "webhook.received"
	}
	props, _ := raw["properties"].(map[string]any)
	profile := ProfileInput{SourceID: "webhook://" + email, Email: email, Traits: props}
	evt := EventInput{SourceID: "webhook://event/" + email, Email: email, EventName: event, Properties: props}
	return SyncRequest{RunMode: "webhook", Profiles: []ProfileInput{profile}, Events: []EventInput{evt}}, true
}

func analyticsWebhookString(node map[string]any, path ...string) string {
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
