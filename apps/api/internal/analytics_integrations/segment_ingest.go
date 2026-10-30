// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const segmentIngestMaxBodyBytes = 1 << 20

// AnalyticsRuntimeSecretResolver resolves a webhook signing-secret reference.
type AnalyticsRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
}

// SegmentIngestStore resolves a Segment integration by its public ingest token.
type SegmentIngestStore interface {
	FindSegmentIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error)
}

// MountPublicRoutes registers the unauthenticated CDP ingest endpoints
// (Segment + RudderStack), each resolving its owning tenant by a per-integration
// URL token.
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/analytics-integrations/segment/ingest/{token}", d.SegmentIngest)
	r.Post("/api/public/analytics-integrations/rudderstack/ingest/{token}", d.RudderStackIngest)
	// Generic webhook ingest for any other analytics/payments/events/cms tool.
	// chi matches the static segment/rudderstack paths above before this {provider}
	// wildcard, so they keep their CDP-specific handlers.
	r.Post("/api/public/analytics-integrations/{provider}/ingest/{token}", d.AnalyticsWebhookIngest)
}

// SegmentIngest receives a Segment identify/track event on a per-integration
// public URL, resolves the owning tenant by the URL token, verifies the
// optional shared-secret signature, maps the event to a canonical profile/event,
// and lands it.
func (d *Deps) SegmentIngest(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "Segment ingest token is required")
		return
	}
	store, ok := d.Repo.(SegmentIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "Segment ingest lookup is not configured")
		return
	}
	integration, err := store.FindSegmentIntegrationByIngestToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Segment integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, segmentIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Segment payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := VerifySegmentSignature(d.segmentSharedSecret(r.Context(), integration), body, r.Header.Get("X-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	req, ok := mapSegmentEvent(body)
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

// segmentSharedSecret resolves the optional Segment webhook signing secret from
// a webhook_secret_ref (via the secrets vault). An empty secret disables
// verification (Segment webhook signing is optional).
func (d *Deps) segmentSharedSecret(ctx context.Context, integration *Integration) string {
	if integration == nil {
		return ""
	}
	ref := strings.TrimSpace(settingString(integration.Settings, "webhook_secret_ref"))
	if ref == "" || d.SegmentSecrets == nil {
		return ""
	}
	secret, err := d.SegmentSecrets.Get(ctx, ref)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("segment ingest: failed to resolve webhook secret", "err", err.Error())
		}
		return ""
	}
	return strings.TrimSpace(secret)
}
