// SPDX-License-Identifier: AGPL-3.0-only

// Package offers is the canonical offer model and its machine-resolvable
// endpoint (PRD F15).
//
// The acceptance criterion is precise and worth restating, because it is what
// the design is for: "the JSON representation is sufficient for an agent to
// determine what is being offered, at what price, until when, and how to act —
// without fetching the HTML."
//
// So the JSON is not a serialisation of a database row that happens to be
// returned. It is a contract with four questions it must answer, and each of the
// four has a way of being silently unanswerable: a price with no currency, an
// expiry expressed only as a cache header, an action url that is a tracking
// redirect to a page rather than a thing to do, and an inventory state that
// defaults to available when nothing knows.
package offers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned for an unknown or non-visible offer.
var ErrNotFound = errors.New("offers: not found")

// errUnsafeProjection is deliberately not returned to public clients. An
// offer containing an unsafe action or terms URL must fail closed instead of
// becoming executable browser markup or machine-readable action data.
var errUnsafeProjection = errors.New("offers: unsafe public projection")

// Offer is the canonical model.
type Offer struct {
	ID         string `json:"id"`
	CampaignID string `json:"campaign_id,omitempty"`
	Type       string `json:"type"`

	Title       string `json:"title"`
	Description string `json:"description,omitempty"`

	// PriceCents and Currency travel together or not at all. A price with no
	// currency cannot be acted on, and the schema enforces the pairing so this
	// type never has to represent the impossible state.
	PriceCents  *int64   `json:"price_cents,omitempty"`
	Currency    string   `json:"currency,omitempty"`
	DiscountPct *float64 `json:"discount_pct,omitempty"`

	ValidFrom *time.Time `json:"valid_from,omitempty"`
	// ValidUntil is in the BODY, not only in a cache header. A cache header tells
	// a cache when to re-ask; this tells a reasoner when the answer stopped being
	// true. An agent that only saw max-age would treat a fetched-and-held offer
	// as valid indefinitely.
	ValidUntil *time.Time `json:"valid_until,omitempty"`

	TermsURL  string `json:"terms_url,omitempty"`
	ActionURL string `json:"action_url,omitempty"`

	// InventoryState is a closed vocabulary, and "unknown" is a real member.
	// Defaulting a missing inventory feed to "in_stock" would have an agent act
	// on availability nobody asserted.
	InventoryState string `json:"inventory_state"`

	Metadata map[string]any `json:"metadata,omitempty"`

	// Expired is derived, not stored, and included so a consumer does not have to
	// implement the comparison — the one place every client would get subtly
	// different (timezone handling, inclusive vs exclusive bounds).
	Expired bool `json:"expired"`
}

// Actionable reports whether an agent can act on this offer right now.
//
// A method rather than a field a caller assembles, because "can I act" is
// exactly the question the endpoint exists to answer and it depends on three
// things at once: the validity window, the inventory state, and whether there is
// an action to take. A consumer checking only the date would happily act on a
// sold-out offer.
func (o Offer) Actionable(now time.Time) bool {
	if !validOfferHTTPSURL(o.ActionURL) {
		return false
	}
	if o.InventoryState != "in_stock" && o.InventoryState != "limited" {
		return false
	}
	if o.ValidFrom != nil && now.Before(*o.ValidFrom) {
		return false
	}
	if o.ValidUntil != nil && !now.Before(*o.ValidUntil) {
		return false
	}
	return true
}

// Repo reads and writes offers.
type Repo struct {
	Pool *db.Pool
	Now  func() time.Time
}

func (r *Repo) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

const offerColumns = `id::text, COALESCE(campaign_id::text, ''), type, title, description,
       price_cents, currency, discount_pct, valid_from, valid_until,
       terms_url, action_url, inventory_state, metadata`

// Get returns one offer.
func (r *Repo) Get(ctx context.Context, tenantID, offerID string) (*Offer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var offer Offer
	var currency *string
	var metadata []byte
	if err := tx.QueryRow(ctx, `SELECT `+offerColumns+`
  FROM offers WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, offerID).
		Scan(&offer.ID, &offer.CampaignID, &offer.Type, &offer.Title, &offer.Description,
			&offer.PriceCents, &currency, &offer.DiscountPct,
			&offer.ValidFrom, &offer.ValidUntil, &offer.TermsURL, &offer.ActionURL,
			&offer.InventoryState, &metadata); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("offers: read canonical offer: %w", err)
	}
	if currency != nil {
		offer.Currency = *currency
	}
	if !validOptionalOfferHTTPSURL(offer.ActionURL) || !validOptionalOfferHTTPSURL(offer.TermsURL) {
		return nil, errUnsafeProjection
	}
	offer.Metadata = decodeMetadata(metadata)
	offer.Expired = offer.ValidUntil != nil && !r.now().Before(*offer.ValidUntil)
	return &offer, nil
}

// CacheControlFor returns the cache policy for one offer.
//
// Bounded by the offer's own expiry rather than a fixed max-age: a five-minute
// cache on an offer expiring in thirty seconds hands an agent a window in which
// it will act on something already over. When the offer has expired the answer is
// no-store, because a cached "expired" is still a fact somebody might act on
// after it changes.
func CacheControlFor(offer *Offer, now time.Time) string {
	const maxAge = 300
	if offer == nil || offer.Expired || !offer.Actionable(now) {
		return "no-store"
	}
	if offer.ValidUntil == nil {
		return "public, max-age=300"
	}
	remaining := int(offer.ValidUntil.Sub(now).Seconds())
	if remaining <= 0 {
		return "no-store"
	}
	if remaining < maxAge {
		return "public, max-age=" + strconv.Itoa(remaining)
	}
	return "public, max-age=300"
}

// validOfferHTTPSURL is the browser/agent action boundary. Database checks
// reject obvious unsafe values too, but this parser remains authoritative for
// legacy rows and for Offer values assembled outside the repository.
func validOfferHTTPSURL(raw string) bool {
	if raw == "" || raw != strings.TrimSpace(raw) || strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.Fragment != "" || parsed.Opaque != "" {
		return false
	}
	return true
}

func validOptionalOfferHTTPSURL(raw string) bool {
	return raw == "" || validOfferHTTPSURL(raw)
}

// WantsJSON decides the representation from the Accept header.
//
// Content negotiation on ONE stable URL is the point of F15: an agent resolving
// a CTA gets structured data and a human gets a page, from the same link that was
// in the email. Two URLs would mean the email had to guess which kind of reader
// would follow it.
//
// Defaults to HTML. A browser that sends `Accept: */*` — or nothing — must get
// the page: guessing JSON for an unspecific Accept would show a person raw data
// in place of the offer they clicked.
func WantsJSON(accept string) bool {
	type representation int
	const (
		representationHTML representation = iota
		representationJSON
	)

	selected := representationHTML
	selectedQuality := -1.0
	for _, part := range strings.Split(accept, ",") {
		mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err != nil {
			continue
		}
		var candidate representation
		switch strings.ToLower(mediaType) {
		case "application/json", "application/ld+json":
			candidate = representationJSON
		case "text/html", "application/xhtml+xml":
			candidate = representationHTML
		default:
			continue
		}

		quality := 1.0
		if raw, ok := params["q"]; ok {
			quality, err = strconv.ParseFloat(raw, 64)
			if err != nil || quality < 0 || quality > 1 {
				continue
			}
		}
		// q=0 means the representation is explicitly unacceptable. Equal
		// quality preserves the caller's header order; if nothing supported is
		// acceptable the endpoint's documented fallback remains HTML.
		if quality == 0 || quality <= selectedQuality {
			continue
		}
		selected = candidate
		selectedQuality = quality
	}
	return selectedQuality >= 0 && selected == representationJSON
}

// WriteCacheHeaders applies the negotiated cache policy.
func WriteCacheHeaders(w http.ResponseWriter, offer *Offer, now time.Time) {
	w.Header().Set("Cache-Control", CacheControlFor(offer, now))
	// Vary on Accept, because the same URL returns two representations. Without
	// it a shared cache can serve the JSON to a browser and the HTML to an agent.
	w.Header().Set("Vary", "Accept")
}

func decodeMetadata(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
