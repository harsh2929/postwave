// SPDX-License-Identifier: AGPL-3.0-only
//
// sync_handlers.go — the two firewall surfaces that hang off an audience
// sync / run id:
//
//	GET /api/v1/audience-syncs/{id}/exclusion-preview          → SyncExclusionPreview
//	GET /api/v1/audience-sync-runs/{run_id}/exclusion-receipt  → text/csv (signed)
//
// These live in the activation_firewall package (not audience_destinations)
// so the firewall owns its own HTTP surface end-to-end; the integrator
// only has to construct SyncDeps with two small interfaces
// (MemberSource + Store) and mount the routes. MemberSource is satisfied
// by a tiny adapter over audience_destinations.SyncRunner (see the
// integration manifest), keeping the member-resolution logic in its
// existing home.
//
// PREVIEW is advisory + bounded: it resolves the sync's members, runs the
// firewall decision in COUNT-ONLY mode (no receipts written), and returns
// the breakdown. A -1 sentinel is returned for any count the source
// could not resolve (ghost source / wire down) so the honest-UI panel
// renders "unavailable", never 0.
//
// RECEIPT carries subscriber emails → admin scope. Signed at download
// time with X-Postwave-Receipt-Signature (outbound_webhooks scheme, D2).
package activation_firewall

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// MemberSource is the firewall's slim view of the sync member resolver.
// It returns the resolved member emails for a sync plus the destination
// type and any per-sync purpose override, so the preview can compute the
// gate exactly as the real run will. Implemented by an adapter over
// audience_destinations.SyncRunner (manifest).
//
// audienceEmails returns sentinel ok=false when the source cannot be
// resolved (ghost source) so the handler emits the -1 sentinel.
type MemberSource interface {
	// SyncActivationContext returns (emails, destinationType, purposeOverride, ok).
	SyncActivationContext(ctx context.Context, tenantID, syncID string) (emails []string, destinationType, purposeOverride string, ok bool, err error)
}

// SyncDeps wires the per-sync firewall handlers.
type SyncDeps struct {
	Filter  *Filter
	Store   Store
	Source  MemberSource
	SignKey string // server signing key (POSTWAVE_OUTBOUND_WEBHOOK_SIGNING_KEY or HMAC_SECRET)
	Logger  *slog.Logger
}

// ReceiptSignatureHeader is the per-download HMAC header (outbound
// webhooks scheme: t=<unix>,v1=<hex>).
const ReceiptSignatureHeader = "X-Postwave-Receipt-Signature"

// SyncExclusionPreview is the GET .../exclusion-preview response. A count
// of -1 means "unavailable" (never coerce to 0 in the UI).
type SyncExclusionPreview struct {
	AudienceCount       int       `json:"audience_count"`
	ExcludedConsent     int       `json:"excluded_consent"`
	ExcludedSuppression int       `json:"excluded_suppression"`
	ExcludedTotal       int       `json:"excluded_total"`
	Purpose             string    `json:"purpose"`
	ComputedAt          time.Time `json:"computed_at"`
}

// unavailablePreview is the all-sentinel response for an unresolvable
// source.
func unavailablePreview(purpose string) SyncExclusionPreview {
	return SyncExclusionPreview{
		AudienceCount:       -1,
		ExcludedConsent:     -1,
		ExcludedSuppression: -1,
		ExcludedTotal:       -1,
		Purpose:             purpose,
		ComputedAt:          time.Now().UTC(),
	}
}

// MountSyncRoutes registers the two per-sync firewall endpoints.
func MountSyncRoutes(r chi.Router, d *SyncDeps) {
	if d == nil || d.Source == nil || d.Filter == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audience-syncs/{id}/exclusion-preview", d.PreviewExclusions)
	if d.Store != nil {
		// Receipt carries emails → admin scope.
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
			Get("/api/v1/audience-sync-runs/{run_id}/exclusion-receipt", d.DownloadExclusionReceipt)
	}
}

// PreviewExclusions GET /api/v1/audience-syncs/{id}/exclusion-preview.
func (d *SyncDeps) PreviewExclusions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	syncID := chi.URLParam(r, "id")
	emails, destType, override, sourceOK, err := d.Source.SyncActivationContext(r.Context(), t.ID, syncID)
	if err != nil {
		// A sync id that resolves to no destination is a 404, not a server
		// failure. This checks THIS package's ErrNotFound rather than
		// audience_destinations' -- importing that here would invert a
		// dependency the codebase deliberately fixes in one direction
		// (audience_destinations imports activation_firewall, never the
		// reverse), and the compiler confirms it: the reverse edge is a cycle.
		// The adapter on the far side translates, which is the only place that
		// can without breaking the boundary.
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "audience sync not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	purpose := ResolvePurpose(destType, override)
	// Optional explicit override via query (advisory preview only).
	if q := r.URL.Query().Get("purpose"); q != "" {
		if p := normalizePurpose(q); p != "" {
			purpose = p
		}
	}
	if !sourceOK {
		writeJSON(w, http.StatusOK, unavailablePreview(string(purpose)))
		return
	}
	dec := d.Filter.Decide(r.Context(), t.ID, purpose, destType, emails)
	var byConsent, bySuppression int
	for _, ex := range dec.Excluded {
		switch ex.RuleClass {
		case RuleClassSuppression:
			bySuppression++
		default:
			// consent + policy(fail-deny) both count as consent-driven
			// from the operator's perspective (the profile lacks a usable
			// consent signal).
			byConsent++
		}
	}
	writeJSON(w, http.StatusOK, SyncExclusionPreview{
		AudienceCount:       len(dec.Kept) + len(dec.Excluded),
		ExcludedConsent:     byConsent,
		ExcludedSuppression: bySuppression,
		ExcludedTotal:       len(dec.Excluded),
		Purpose:             string(purpose),
		ComputedAt:          time.Now().UTC(),
	})
}

// DownloadExclusionReceipt GET /api/v1/audience-sync-runs/{run_id}/exclusion-receipt.
// Streams the run's exclusion receipts as a signed CSV.
func (d *SyncDeps) DownloadExclusionReceipt(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runID := chi.URLParam(r, "run_id")
	rows, err := d.Store.ListExclusionsForRun(r.Context(), t.ID, runID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Build the CSV body in memory (capped at receiptListCap rows) so we
	// can sign the exact bytes we send.
	header := []string{
		"subscriber_email", "rule_class", "rule_reason", "purpose",
		"consent_event_id", "excluded_at", "signature",
	}
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write(header)
	for _, rec := range rows {
		cev := ""
		if rec.ConsentEventID != nil {
			cev = strconv.FormatInt(*rec.ConsentEventID, 10)
		}
		_ = cw.Write([]string{
			rec.SubscriberEmail, rec.RuleClass, rec.RuleReason, rec.Purpose,
			cev, rec.ExcludedAt.UTC().Format(time.RFC3339), rec.Signature,
		})
	}
	cw.Flush()
	body := buf.Bytes()

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="exclusion-receipt-`+sanitizeFilename(runID)+`.csv"`)
	if d.SignKey != "" {
		w.Header().Set(ReceiptSignatureHeader, outbound_webhooks.SignBody(d.SignKey, time.Now(), body))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// sanitizeFilename strips characters that would break the
// Content-Disposition header. run ids are uuids/opaque tokens so this is
// belt-and-suspenders.
func sanitizeFilename(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}
