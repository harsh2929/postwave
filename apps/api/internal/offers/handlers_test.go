// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// One URL serves both readers, and the negotiation is what makes that possible.
//
// The link in an email cannot know whether an agent or a person will follow it.
// Two URLs would force that guess at authoring time, and the author does not know
// either — which is why the PRD asks for negotiation on a single stable URL rather
// than a /json variant.
func TestOneURLServesJSONToAgentsAndHTMLToPeople(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	until := now.Add(24 * time.Hour)
	price := int64(12900)
	offer := &Offer{
		ID: "off_1", Type: "discount", Title: "Spring sale",
		Description: "20% off everything",
		PriceCents:  &price, Currency: "USD",
		ValidUntil: &until, ActionURL: "https://example.test/buy",
		InventoryState: "in_stock",
	}

	t.Run("an agent asking for JSON gets structured data", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteCacheHeaders(rec, offer, now)
		writeJSON(rec, http.StatusOK, offerResponse(offer, now))

		if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
			t.Fatalf("content-type = %q", got)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		// The four acceptance answers must be present without fetching HTML.
		inner, _ := body["offer"].(map[string]any)
		for _, field := range []string{"title", "price_cents", "currency", "valid_until", "action_url"} {
			if _, ok := inner[field]; !ok {
				t.Errorf("JSON is missing %q, so an agent cannot answer one of the "+
					"four acceptance questions without fetching the page", field)
			}
		}
		// actionable is DERIVED here so every client agrees. A consumer computing
		// it from the date alone would act on a sold-out offer.
		if actionable, ok := body["actionable"].(bool); !ok || !actionable {
			t.Errorf("actionable = %v, want true for a live in-stock offer", body["actionable"])
		}
	})

	t.Run("a person gets a page that states the deadline", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeOfferHTML(rec, offer, now)

		if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/html") {
			t.Fatalf("content-type = %q", got)
		}
		page := rec.Body.String()
		for _, want := range []string{"Spring sale", "129.00 USD", "Available until", "https://example.test/buy"} {
			if !strings.Contains(page, want) {
				t.Errorf("the page omits %q — a person deciding whether to act needs "+
					"the deadline and the price as much as an agent does", want)
			}
		}
	})

	// Vary: Accept is required, or a shared cache serves the JSON to a browser.
	rec := httptest.NewRecorder()
	WriteCacheHeaders(rec, offer, now)
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept") {
		t.Errorf("Vary = %q, want Accept — one URL with two representations and no "+
			"Vary lets a shared cache serve the wrong one to the wrong reader", got)
	}
}

// An expired offer says so to both readers, and is never cached.
func TestAnExpiredOfferSaysSoAndIsNotCached(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	past := now.Add(-time.Hour)
	offer := &Offer{
		ID: "off_2", Type: "discount", Title: "Winter sale",
		ValidUntil: &past, Expired: true,
		ActionURL: "https://example.test/buy", InventoryState: "in_stock",
	}

	rec := httptest.NewRecorder()
	WriteCacheHeaders(rec, offer, now)
	writeOfferHTML(rec, offer, now)

	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("cache-control = %q for an expired offer, want no-store", got)
	}
	page := rec.Body.String()
	if !strings.Contains(page, "has ended") {
		t.Error("the page does not tell a person the offer has ended")
	}
	if strings.Contains(page, "Continue") {
		t.Error("an expired offer still renders its call to action")
	}
}

// A sold-out offer is not actionable, and the page says why.
func TestASoldOutOfferIsNotActionable(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	until := now.Add(24 * time.Hour)
	offer := &Offer{
		ID: "off_3", Type: "product", Title: "Field notebook",
		ValidUntil: &until, ActionURL: "https://example.test/buy",
		InventoryState: "sold_out",
	}
	rec := httptest.NewRecorder()
	writeOfferHTML(rec, offer, now)
	page := rec.Body.String()
	if strings.Contains(page, "Continue") {
		t.Error("a sold-out offer renders its call to action")
	}
	if !strings.Contains(page, "sold out") {
		t.Error("the page does not say the offer is sold out")
	}
}

// Author-supplied fields are escaped before reaching a browser.
func TestOfferFieldsAreEscapedInTheHTML(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	offer := &Offer{
		ID: "off_4", Type: "content",
		Title:       `Spring <script>alert(1)</script>`,
		Description: `"quoted" & <b>bold</b>`,
		ActionURL:   `https://example.test/buy?a=1&b=2`,
	}
	rec := httptest.NewRecorder()
	writeOfferHTML(rec, offer, now)
	page := rec.Body.String()

	if strings.Contains(page, "<script>") {
		t.Fatal("an author-supplied title reached the browser unescaped; these " +
			"fields are author input and this page renders in a recipient's browser")
	}
	if !strings.Contains(page, "&amp;") {
		t.Error("ampersands were not escaped")
	}
}

func TestUnsafeURLsNeverReachPublicHTMLOrJSON(t *testing.T) {
	t.Parallel()
	now := at("2026-05-01T12:00:00Z")
	offer := &Offer{
		ID: "off_unsafe", Type: "discount", Title: "Unsafe",
		ActionURL: "javascript:alert(1)", TermsURL: "data:text/html,pwned",
		InventoryState: "in_stock",
	}
	htmlResponse := httptest.NewRecorder()
	writeOfferHTML(htmlResponse, offer, now)
	if body := htmlResponse.Body.String(); strings.Contains(body, "javascript:") ||
		strings.Contains(body, "data:text") || strings.Contains(body, "Continue") {
		t.Fatalf("unsafe URL reached public HTML: %s", body)
	}

	jsonResponse := httptest.NewRecorder()
	writeJSON(jsonResponse, http.StatusOK, offerResponse(offer, now))
	if body := jsonResponse.Body.String(); strings.Contains(body, "javascript:") ||
		strings.Contains(body, "data:text") || strings.Contains(body, `"actionable":true`) {
		t.Fatalf("unsafe URL reached public JSON: %s", body)
	}
}

func TestPublicOfferResolutionIsReleaseHeld(t *testing.T) {
	if PublicResolutionAvailable {
		t.Fatal("public offer resolution became available without release certification")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/public/offers/anything", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Resolve(rec, req)
	if rec.Code != http.StatusServiceUnavailable ||
		rec.Header().Get("Cache-Control") != "private, no-store" ||
		!strings.Contains(rec.Body.String(), `"code":"`+PublicResolutionReleaseHoldCode+`"`) {
		t.Fatalf("held resolver response = %d cache=%q body=%s, want stable 503/no-store",
			rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}

	router := chi.NewRouter()
	MountPublicRoutes(router, nil)
	mounted := httptest.NewRecorder()
	router.ServeHTTP(mounted, req)
	if mounted.Code != http.StatusServiceUnavailable ||
		!strings.Contains(mounted.Body.String(), `"code":"`+PublicResolutionReleaseHoldCode+`"`) {
		t.Fatalf("mounted hold response = %d %s", mounted.Code, mounted.Body.String())
	}
}

func TestDormantResolverDistinguishesAMissFromAnOutage(t *testing.T) {
	request := func() *http.Request {
		route := chi.NewRouteContext()
		route.URLParams.Add("offer", "11111111-1111-4111-8111-111111111111")
		ctx := context.WithValue(context.Background(), chi.RouteCtxKey, route)
		req := httptest.NewRequest(http.MethodGet, "/api/public/offers/ignored", nil).WithContext(ctx)
		req.Header.Set("Accept", "application/json")
		return req
	}
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"miss", ErrNotFound, http.StatusNotFound},
		{"database outage", errors.New("database unavailable"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := &Deps{
				Repo: &Repo{Pool: &db.Pool{}},
				TenantResolver: func(context.Context, string) (string, error) {
					return "", tc.err
				},
			}
			rec := httptest.NewRecorder()
			deps.resolve(rec, request())
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tc.status, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("error response cache policy = %q", rec.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestPublicProjectionDropsUnreviewedMetadata(t *testing.T) {
	offer := &Offer{
		Title: "Safe fields", InventoryState: "unknown",
		CampaignID: "11111111-1111-4111-8111-111111111111",
		Metadata:   map[string]any{"internal_segment": "enterprise", "provider_ref": "secret-ish"},
	}
	response := publicOfferResponse(offer, time.Now())
	projection, ok := response["offer"].(*Offer)
	if !ok {
		t.Fatalf("public projection type = %T", response["offer"])
	}
	if projection.Metadata != nil {
		t.Fatalf("unreviewed metadata reached public projection: %#v", projection.Metadata)
	}
	if projection.CampaignID != "" {
		t.Fatalf("internal campaign linkage reached public projection: %q", projection.CampaignID)
	}
	if offer.Metadata == nil {
		t.Fatal("public projection mutated the canonical authenticated offer")
	}
}

// Money is rendered with its ISO code rather than a guessed symbol.
func TestMoneyRendersWithItsISOCode(t *testing.T) {
	for _, tc := range []struct {
		cents    int64
		currency string
		want     string
	}{
		{12900, "USD", "129.00 USD"},
		{5, "usd", "0.05 USD"},
		{100000, "JPY", "1000.00 JPY"},
		{-2500, "EUR", "-25.00 EUR"},
	} {
		if got := formatMoney(tc.cents, tc.currency); got != tc.want {
			t.Errorf("formatMoney(%d, %q) = %q, want %q — guessing a locale from an "+
				"email click gets it wrong often enough that the ISO code is more "+
				"honest than a confidently wrong symbol", tc.cents, tc.currency, got, tc.want)
		}
	}
}
