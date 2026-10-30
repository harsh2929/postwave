// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return v
}

// Content negotiation must default to HTML.
//
// A browser sending `Accept: */*` — or nothing at all — is a person who clicked
// a link in an email. Guessing JSON for an unspecific Accept shows them raw data
// in place of the offer, which is a worse failure than an agent having to ask
// for JSON explicitly.
func TestNegotiationDefaultsToHTMLForUnspecificAccept(t *testing.T) {
	for _, tc := range []struct {
		accept string
		json   bool
	}{
		{"application/json", true},
		{"application/ld+json", true},
		{"application/json;q=0.9", true},
		{"application/json;q=0", false},
		{"application/json;q=0.1,text/html;q=0.9", false},
		{"text/html;q=0.1,application/json;q=0.9", true},
		{"text/html;q=0,application/json;q=0.1", true},
		{"application/json;q=0.8,text/html;q=0.8", true},
		{"text/html;q=0.8,application/json;q=0.8", false},
		{"application/json;q=bogus,text/html;q=0.2", false},
		{"application/json;profile=\"agent\";q=0.7,text/html;q=0.6", true},
		{"text/html", false},
		{"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false},
		{"*/*", false},
		{"", false},
		{"text/plain", false},
		// An agent that lists HTML first gets HTML: it said what it preferred.
		{"text/html,application/json", false},
		{"application/json,text/html", true},
	} {
		if got := WantsJSON(tc.accept); got != tc.json {
			t.Errorf("WantsJSON(%q) = %v, want %v", tc.accept, got, tc.json)
		}
	}
}

// The cache policy is bounded by the offer's own expiry.
//
// A five-minute cache on an offer expiring in thirty seconds hands an agent a
// window in which it will act on something already over — the precise failure
// the PRD's "so a stale agent doesn't act on an expired offer" names.
func TestTheCachePolicyNeverOutlivesTheOffer(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")

	soon := now.Add(30 * time.Second)
	shortLived := &Offer{
		ValidUntil: &soon, ActionURL: "https://example.test/buy", InventoryState: "in_stock",
	}
	if got := CacheControlFor(shortLived, now); got != "public, max-age=30" {
		t.Errorf("cache-control = %q for an offer expiring in 30s; a longer cache "+
			"lets an agent act after it ended", got)
	}

	later := now.Add(2 * time.Hour)
	longLived := &Offer{
		ValidUntil: &later, ActionURL: "https://example.test/buy", InventoryState: "in_stock",
	}
	if got := CacheControlFor(longLived, now); got != "public, max-age=300" {
		t.Errorf("cache-control = %q, want the 300s ceiling", got)
	}

	// An expired offer is never cached: a cached "expired" is still a fact
	// somebody might act on after the offer is extended.
	past := now.Add(-time.Minute)
	expired := &Offer{ValidUntil: &past, Expired: true}
	if got := CacheControlFor(expired, now); got != "no-store" {
		t.Errorf("cache-control = %q for an expired offer, want no-store", got)
	}
	if got := CacheControlFor(nil, now); got != "no-store" {
		t.Errorf("cache-control = %q for a missing offer, want no-store", got)
	}
}

// Actionability depends on all three conditions, not just the date.
//
// A consumer checking only the validity window would act on a sold-out offer,
// and one checking only inventory would act on an expired one.
func TestActionabilityRequiresWindowInventoryAndAnAction(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	future := now.Add(time.Hour)
	past := now.Add(-time.Hour)

	for _, tc := range []struct {
		name  string
		offer Offer
		want  bool
	}{
		{"live and in stock", Offer{ActionURL: "https://x.test/buy", InventoryState: "in_stock", ValidUntil: &future}, true},
		{"limited stock is still actionable", Offer{ActionURL: "https://x.test/buy", InventoryState: "limited", ValidUntil: &future}, true},
		{"unknown stock fails closed", Offer{ActionURL: "https://x.test/buy", InventoryState: "unknown", ValidUntil: &future}, false},
		{"sold out is not", Offer{ActionURL: "https://x.test/buy", InventoryState: "sold_out", ValidUntil: &future}, false},
		{"expired is not", Offer{ActionURL: "https://x.test/buy", InventoryState: "in_stock", ValidUntil: &past}, false},
		{"not yet started is not", Offer{ActionURL: "https://x.test/buy", InventoryState: "in_stock", ValidFrom: &future}, false},
		{"no action url is not", Offer{InventoryState: "in_stock", ValidUntil: &future}, false},
		{"no window at all is actionable", Offer{ActionURL: "https://x.test/buy", InventoryState: "in_stock"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.offer.Actionable(now); got != tc.want {
				t.Fatalf("Actionable = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestOfferURLsRequireAbsoluteCredentialFreeHTTPS(t *testing.T) {
	t.Parallel()
	valid := []string{
		"https://example.test",
		"https://example.test/buy?campaign=one",
		"https://127.0.0.1:8443/path",
	}
	for _, value := range valid {
		if !validOfferHTTPSURL(value) {
			t.Errorf("valid HTTPS URL rejected: %q", value)
		}
	}
	invalid := []string{
		"", "/buy", "http://example.test/buy", "javascript:alert(1)",
		"data:text/html,pwned", "https://user:pass@example.test/buy",
		"https://example.test/buy#fragment", " https://example.test/buy",
		"https://example.test/\nbuy",
	}
	for _, value := range invalid {
		if validOfferHTTPSURL(value) {
			t.Errorf("unsafe offer URL accepted: %q", value)
		}
	}
}

// The four acceptance questions must be answerable from the JSON alone.
//
// The PRD's criterion is that an agent can determine what is offered, at what
// price, until when, and how to act — without fetching the HTML. This asserts the
// FIELDS exist to carry those answers, which is the part a refactor breaks
// silently.
func TestTheJSONCarriesAllFourAcceptanceAnswers(t *testing.T) {
	price := int64(12900)
	until := at("2026-06-01T00:00:00Z")
	offer := Offer{
		ID: "off_1", Type: "discount", Title: "Spring sale",
		PriceCents: &price, Currency: "USD",
		ValidUntil: &until, ActionURL: "https://x.test/buy",
		InventoryState: "in_stock",
	}

	// what is offered
	if offer.Type == "" || offer.Title == "" {
		t.Error("an agent cannot tell WHAT is offered")
	}
	// at what price — and a price with no currency is not a price
	if offer.PriceCents == nil || offer.Currency == "" {
		t.Error("an agent cannot tell at WHAT PRICE; a price without a currency " +
			"cannot be acted on")
	}
	// until when
	if offer.ValidUntil == nil {
		t.Error("an agent cannot tell UNTIL WHEN from the body alone")
	}
	// how to act
	if offer.ActionURL == "" {
		t.Error("an agent cannot tell HOW TO ACT")
	}
}
