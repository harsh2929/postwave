// SPDX-License-Identifier: AGPL-3.0-only
//
// rudderstack.go — native RudderStack CDP inbound runtime.
//
// RudderStack is an open-source, Segment-spec-compatible CDP: its Webhook
// destination emits the same identify/track event shape as Segment. The mapping
// therefore reuses the shared CDP core (mapCDPEvent); only the source-ID
// namespace, the per-integration ingest token lookup, and the (optional) shared
// secret differ. RudderStack webhook destinations authenticate via a configured
// custom header rather than an HMAC signature, so verification is an optional
// constant-time token compare.
package analytics_integrations

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const rudderStackIngestMaxBodyBytes = 1 << 20

// mapRudderStackEvent translates a single RudderStack (Segment-spec) identify or
// track payload into a canonical profile/event upsert.
func mapRudderStackEvent(body []byte) (SyncRequest, bool) {
	return mapCDPEvent(body, "rudderstack")
}

// VerifyRudderStackSecret validates the optional RudderStack webhook shared
// secret. RudderStack's Webhook destination sends a configured custom header
// (commonly Authorization); an empty configured secret disables verification.
// A "Bearer " prefix on the header is tolerated.
func VerifyRudderStackSecret(secret, header string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	header = strings.TrimSpace(header)
	if rest, found := strings.CutPrefix(header, "Bearer "); found {
		header = strings.TrimSpace(rest)
	}
	if header == "" {
		return fmt.Errorf("rudderstack webhook secret is required")
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(header)) != 1 {
		return fmt.Errorf("rudderstack webhook secret mismatch")
	}
	return nil
}

// RudderStackIngestStore resolves a RudderStack integration by its public ingest
// token.
type RudderStackIngestStore interface {
	FindRudderStackIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error)
}

// RudderStackIngest receives a RudderStack identify/track event on a
// per-integration public URL, resolves the owning tenant by the URL token,
// verifies the optional shared secret, maps the event to a canonical
// profile/event, and lands it. Mirrors SegmentIngest.
func (d *Deps) RudderStackIngest(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "RudderStack ingest token is required")
		return
	}
	store, ok := d.Repo.(RudderStackIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "RudderStack ingest lookup is not configured")
		return
	}
	integration, err := store.FindRudderStackIntegrationByIngestToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "RudderStack integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, rudderStackIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "RudderStack payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := VerifyRudderStackSecret(d.rudderStackSharedSecret(r.Context(), integration), r.Header.Get("Authorization")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	req, ok := mapRudderStackEvent(body)
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

// rudderStackSharedSecret resolves the optional RudderStack webhook secret from
// a webhook_secret_ref via the secrets vault. Empty disables verification.
func (d *Deps) rudderStackSharedSecret(ctx context.Context, integration *Integration) string {
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
			d.Logger.Warn("rudderstack ingest: failed to resolve webhook secret", "err", err.Error())
		}
		return ""
	}
	return strings.TrimSpace(secret)
}
