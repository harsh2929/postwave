// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The vanity path surface, as HTTP (PRD F04).
//
// GET /go/{slug} is the only unauthenticated route here, and it is the one an
// attacker reaches. Three properties are load-bearing and each is asserted by a
// test rather than left to review:
//
//  1. Every miss is the same response. Unknown slug, disabled path, malformed
//     slug, host that lost verification — one status, one body. Anything else
//     is an oracle for "which campaigns is this workspace running".
//  2. Nothing in the request influences the redirect target. Not a query
//     parameter, not a header. The Location is built from a stored verified
//     host and a stored validated path, so /go/{slug} cannot be used as an open
//     redirect against our own domain.
//  3. The attribution recorded names the campaign and no person, because a
//     shared URL cannot say who walked through it.

// VanityDeps carries the vanity path HTTP surface.
type VanityDeps struct {
	Repo   *VanityRepo
	Logger *slog.Logger
}

func (d *VanityDeps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// MountPublicVanityRoutes registers the recipient-facing redirect.
//
// GET only. A HEAD or a prefetch would record a visit nobody made, and a vanity
// path has no two-step split available to it — unlike internal/polls, the
// recipient's action here IS a plain navigation.
func MountPublicVanityRoutes(r chi.Router, d *VanityDeps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.Get("/go/{slug}", d.Visit)
}

// MountVanityAdminRoutes registers authoring and the conversion report.
func MountVanityAdminRoutes(r chi.Router, d *VanityDeps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.Post("/api/v1/campaigns/{campaign}/vanity-paths", d.CreatePath)
	r.Get("/api/v1/campaigns/{campaign}/vanity-paths", d.ListPaths)
	r.Post("/api/v1/vanity-visits/{reference}/conversion", d.ReportConversion)
}

// Visit resolves /go/{slug}, records the campaign attribution and redirects.
func (d *VanityDeps) Visit(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))

	// The request is read for the slug and for nothing else. Any recipient
	// identifier riding along is passed to RecordVisit precisely so that
	// discarding it is a decision with a name, and a test can hold it there.
	result, err := d.Repo.RecordVisit(r.Context(), slug, VisitRequest{
		SubscriberHint: r.URL.Query().Get("s"),
	})
	if err != nil {
		d.writeVanityMiss(w, err)
		return
	}

	// no-store on the redirect too: a shared cache that served this 302 to a
	// second person would swallow their visit, and the campaign would be
	// credited once for two arrivals.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// Built from stored values only — see buildDestination. r.URL.Query() is
	// never consulted for a destination.
	w.Header().Set("Location", result.Destination)
	w.WriteHeader(http.StatusFound)
}

// writeVanityMiss is the ONE response every failure of the PUBLIC route
// produces, whatever went wrong.
//
// This is the whole enumeration defence and it lives here rather than in the
// repository, which is allowed to know the difference between a typo, a retired
// path and a domain that lost verification. The status, the body and the
// headers do not depend on which of those it was — and a genuine internal fault
// answers identically too, because a 500 on one slug beside a 404 on another is
// the same oracle wearing a different number.
func (d *VanityDeps) writeVanityMiss(w http.ResponseWriter, err error) {
	if !isVanityMiss(err) {
		d.log().Error("coderedemption: vanity visit failed", "err", err.Error())
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
}

// isVanityMiss reports whether an error is an expected public miss, so only a
// genuine fault reaches the log. It changes nothing a caller can observe.
func isVanityMiss(err error) bool {
	return errors.Is(err, ErrUnknownPath) ||
		errors.Is(err, ErrPathDisabled) ||
		errors.Is(err, ErrDestinationUnverified)
}

type createVanityPathRequest struct {
	Slug            string `json:"slug"`
	DestinationHost string `json:"destination_host"`
	DestinationPath string `json:"destination_path,omitempty"`
}

// CreatePath publishes a vanity path for a campaign.
func (d *VanityDeps) CreatePath(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	var in createVanityPathRequest
	if err := httpbody.DecodeJSONWith(w, r, 8<<10, &in, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      true,
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	record, err := d.Repo.CreatePath(r.Context(), t.ID, NewPath{
		Slug:            in.Slug,
		CampaignID:      strings.TrimSpace(chi.URLParam(r, "campaign")),
		DestinationHost: in.DestinationHost,
		DestinationPath: in.DestinationPath,
	})
	if err != nil {
		d.writeVanityError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":               record.ID,
		"slug":             record.Slug,
		"campaign_id":      record.CampaignID,
		"public_path":      "/go/" + record.Slug,
		"destination_host": record.DestinationHost,
		"destination_path": record.DestinationPath,
		"status":           record.Status,
		// Stated on the authoring response so whoever publishes the link knows
		// what it will and will not prove before they print it anywhere.
		"attribution_scope": AttributionScopeCampaign,
		"attributed_via":    AttributedViaVanityPath,
	})
}

// ListPaths returns a campaign's vanity paths.
func (d *VanityDeps) ListPaths(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	records, err := d.Repo.ListPaths(r.Context(), t.ID, strings.TrimSpace(chi.URLParam(r, "campaign")))
	if err != nil {
		d.writeVanityError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		items = append(items, map[string]any{
			"id":               record.ID,
			"slug":             record.Slug,
			"public_path":      "/go/" + record.Slug,
			"destination_host": record.DestinationHost,
			"destination_path": record.DestinationPath,
			"status":           record.Status,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type vanityConversionRequest struct {
	AmountCents int64      `json:"amount_cents"`
	Currency    string     `json:"currency,omitempty"`
	OccurredAt  *time.Time `json:"occurred_at,omitempty"`
	// Accepted so a commerce system does not have to strip it, and then dropped.
	// See VanityConversion.CustomerEmail.
	CustomerEmail string `json:"customer_email,omitempty"`
}

// ReportConversion credits a conversion to the campaign behind a visit.
func (d *VanityDeps) ReportConversion(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	var in vanityConversionRequest
	if err := httpbody.DecodeJSONWith(w, r, 8<<10, &in, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      true,
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	conversion := VanityConversion{
		AmountCents:   in.AmountCents,
		Currency:      in.Currency,
		CustomerEmail: in.CustomerEmail,
	}
	if in.OccurredAt != nil {
		conversion.OccurredAt = in.OccurredAt.UTC()
	}
	result, err := d.Repo.AttributeConversion(
		r.Context(), t.ID, strings.TrimSpace(chi.URLParam(r, "reference")), conversion)
	if err != nil {
		d.writeVanityError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recorded":      true,
		"conversion_id": result.ConversionID,
		"campaign_id":   result.CampaignID,
		// The honest limit of the claim, returned rather than assumed. A caller
		// integrating this must not report it as per-subscriber revenue.
		"attribution_scope": result.AttributionScope,
		"attributed_via":    result.AttributedVia,
	})
}

// writeVanityError serves the AUTHENTICATED routes, where an author is entitled
// to know why their request failed. The public route never reaches this.
func (d *VanityDeps) writeVanityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidSlug):
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "slug must be 1-64 lowercase letters, digits or interior dashes",
			"code":  "invalid_slug"})
	case errors.Is(err, ErrUnsafeDestination):
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "destination must be a path on a verified domain of this workspace",
			"code":  "unsafe_destination"})
	case errors.Is(err, ErrSlugUnavailable):
		// 409, and never "owned by another workspace": slugs are global, and
		// saying who holds one would leak across the tenant boundary.
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "that vanity slug is already in use", "code": "slug_unavailable"})
	case errors.Is(err, ErrUnknownPath), errors.Is(err, ErrUnknownVisit):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	case errors.Is(err, ErrVisitAlreadyConverted):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "that visit already carries a conversion", "code": "already_converted"})
	default:
		d.log().Error("coderedemption: vanity request failed", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
	}
}
