// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// PublicResolutionAvailable is the compile-time release boundary for the
// unauthenticated canonical-offer resolver. Keep it false until a production
// writer establishes recipient/subscription/tier eligibility, the public
// projection has an approved field allowlist, and origination plus provider
// reconciliation have live certification. A globally unique UUID and a safe
// read projection do not make every tenant-authored offer publicly eligible.
const PublicResolutionAvailable = false

// PublicResolutionReleaseHoldCode is returned by the mounted public boundary
// until recipient eligibility, origination, and provider reconciliation have
// production certification. Keeping the hold route mounted makes the OpenAPI
// 503 contract observable without exposing the dormant resolver.
const PublicResolutionReleaseHoldCode = "assure_f15_public_offer_unwired"

var errTenantResolverUnavailable = errors.New("offers: public tenant resolver unavailable")

// One stable URL, two representations (PRD F15 §17.2).
//
// Content negotiation on a single URL is the point: the link in the email does
// not have to guess whether an agent or a person will follow it. Two URLs would
// force that guess at authoring time, and the author does not know.
//
// The structural route is /api/public/offers/{offer}. While
// PublicResolutionAvailable is false it mounts only a stable no-store 503 hold
// handler; the content-negotiated resolver remains unreachable.

// Deps carries the offer HTTP surface.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// TenantResolver maps a public request to a tenant.
	//
	// Offers are read WITHOUT a session — an agent resolving a CTA has no
	// credentials — so the tenant has to come from somewhere. The offer id is a
	// UUID and globally unique, so a resolver that looks the offer up across
	// tenants is the honest option; requiring a tenant in the path would make the
	// URL longer and leak the tenant id into every email body.
	TenantResolver func(ctx context.Context, offerID string) (string, error)
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// MountPublicRoutes registers the agent- and human-facing offer endpoint.
func MountPublicRoutes(r chi.Router, d *Deps) {
	if !PublicResolutionAvailable {
		r.Get("/api/public/offers/{offer}", publicResolutionReleaseHold)
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil ||
		d.TenantResolver == nil {
		return
	}
	r.Get("/api/public/offers/{offer}", d.Resolve)
}

// MountAdminRoutes registers the authenticated offer read.
func MountAdminRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.Get("/api/v1/offers/{offer}", d.Get)
}

// Resolve serves an offer to whichever kind of reader asked for it.
func (d *Deps) Resolve(w http.ResponseWriter, r *http.Request) {
	if !PublicResolutionAvailable {
		publicResolutionReleaseHold(w, r)
		return
	}
	d.resolve(w, r)
}

func publicResolutionReleaseHold(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": map[string]string{
			"code":    PublicResolutionReleaseHoldCode,
			"message": "public offer resolution is release-held",
		},
	})
}

// resolve contains the dormant implementation behind Resolve's release gate.
// Keeping it separately testable ensures cancellation and outage semantics do
// not rot while the production route is held.
func (d *Deps) resolve(w http.ResponseWriter, r *http.Request) {
	offerID := strings.TrimSpace(chi.URLParam(r, "offer"))
	if d == nil || d.Repo == nil || d.Repo.Pool == nil || d.TenantResolver == nil {
		if d == nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
			return
		}
		d.writeError(w, r, errTenantResolverUnavailable)
		return
	}
	tenantID, err := d.TenantResolver(r.Context(), offerID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}

	offer, err := d.Repo.Get(r.Context(), tenantID, offerID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}

	now := d.Repo.now()
	WriteCacheHeaders(w, offer, now)

	if WantsJSON(r.Header.Get("Accept")) {
		writeJSON(w, http.StatusOK, publicOfferResponse(offer, now))
		return
	}
	writeOfferHTML(w, offer, now)
}

// Get is the authenticated read.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	offer, err := d.Repo.Get(r.Context(), t.ID, strings.TrimSpace(chi.URLParam(r, "offer")))
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	now := d.Repo.now()
	WriteCacheHeaders(w, offer, now)
	writeJSON(w, http.StatusOK, offerResponse(offer, now))
}

// offerResponse adds the derived fields an agent would otherwise have to compute.
//
// `actionable` in particular: it depends on the validity window AND the inventory
// state AND having an action at all, and a consumer checking only the date would
// happily act on a sold-out offer. Computing it here means every client gets the
// same answer.
func offerResponse(offer *Offer, now time.Time) map[string]any {
	projection := safeOfferProjection(offer)
	return map[string]any{
		"offer":      projection,
		"actionable": projection.Actionable(now),
		"as_of":      now,
	}
}

// publicOfferResponse is an allowlist boundary, not a raw-row serialization.
// No metadata keys have completed public-data review, so the public projection
// exposes none. The authenticated tenant read keeps the canonical metadata.
func publicOfferResponse(offer *Offer, now time.Time) map[string]any {
	projection := safeOfferProjection(offer)
	projection.CampaignID = ""
	projection.Metadata = nil
	return map[string]any{
		"offer":      projection,
		"actionable": projection.Actionable(now),
		"as_of":      now,
	}
}

func safeOfferProjection(offer *Offer) *Offer {
	if offer == nil {
		return &Offer{}
	}
	projection := *offer
	if !validOptionalOfferHTTPSURL(projection.ActionURL) {
		projection.ActionURL = ""
	}
	if !validOptionalOfferHTTPSURL(projection.TermsURL) {
		projection.TermsURL = ""
	}
	return &projection
}

func (d *Deps) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept")
	if errors.Is(err, ErrNotFound) {
		// no-store on a miss as well as on an expiry: a cached 404 for an offer
		// that is about to be created is its own small outage.
		if WantsJSON(r.Header.Get("Accept")) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		http.Error(w, "Offer not found", http.StatusNotFound)
		return
	}
	d.log().Error("offers: request failed", "err", err.Error())
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeOfferHTML renders the human landing page.
//
// Deliberately minimal and self-contained: this is the page a person lands on
// from an email, and an offer that cannot render without a stylesheet fetch is an
// offer that renders blank on a slow connection. Everything is escaped — the
// fields are author-supplied and reach a browser.
func writeOfferHTML(w http.ResponseWriter, offer *Offer, now time.Time) {
	offer = safeOfferProjection(offer)
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="en"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	b.WriteString("<title>")
	b.WriteString(html.EscapeString(offer.Title))
	b.WriteString("</title></head><body>")
	b.WriteString("<h1>")
	b.WriteString(html.EscapeString(offer.Title))
	b.WriteString("</h1>")
	if offer.Description != "" {
		b.WriteString("<p>")
		b.WriteString(html.EscapeString(offer.Description))
		b.WriteString("</p>")
	}
	if offer.PriceCents != nil && offer.Currency != "" {
		b.WriteString("<p>")
		b.WriteString(html.EscapeString(formatMoney(*offer.PriceCents, offer.Currency)))
		b.WriteString("</p>")
	}
	// The expiry is stated to the HUMAN too, not only in the JSON. A person
	// deciding whether to act needs the deadline as much as an agent does.
	if offer.ValidUntil != nil {
		b.WriteString("<p>Available until ")
		b.WriteString(html.EscapeString(offer.ValidUntil.UTC().Format(time.RFC1123)))
		b.WriteString("</p>")
	}
	if offer.Expired {
		b.WriteString("<p><strong>This offer has ended.</strong></p>")
	} else if offer.Actionable(now) && offer.ActionURL != "" {
		b.WriteString(`<p><a href="`)
		b.WriteString(html.EscapeString(offer.ActionURL))
		b.WriteString(`">Continue</a></p>`)
	} else if offer.InventoryState == "sold_out" {
		b.WriteString("<p><strong>This offer is sold out.</strong></p>")
	} else if offer.InventoryState == "unknown" {
		b.WriteString("<p><strong>Availability cannot be confirmed.</strong></p>")
	}
	if validOfferHTTPSURL(offer.TermsURL) {
		b.WriteString(`<p><a href="`)
		b.WriteString(html.EscapeString(offer.TermsURL))
		b.WriteString(`">Terms</a></p>`)
	}
	b.WriteString("</body></html>")

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

// formatMoney renders minor units without pretending to localise.
//
// Two decimals and the ISO code, not a locale-aware symbol: guessing a reader's
// locale from an email click gets it wrong often enough that "129.00 USD" is more
// honest than a confidently wrong "£129.00".
func formatMoney(cents int64, currency string) string {
	negative := cents < 0
	if negative {
		cents = -cents
	}
	whole := cents / 100
	frac := cents % 100
	out := strconv.FormatInt(whole, 10) + "." + pad2(frac) + " " + strings.ToUpper(currency)
	if negative {
		return "-" + out
	}
	return out
}

func pad2(v int64) string {
	if v < 10 {
		return "0" + strconv.FormatInt(v, 10)
	}
	return strconv.FormatInt(v, 10)
}
