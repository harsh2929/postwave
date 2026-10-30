package paid_tiers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestGiftHistoryProjectionOmitsSensitiveFields(t *testing.T) {
	record := GiftHistoryRecord{
		ID:                    "11111111-1111-4111-8111-111111111111",
		Label:                 "Gift record 11111111",
		PlanLabel:             "Studio Annual",
		DurationMonths:        12,
		Status:                "redeemed",
		CreatedAt:             time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		MessageRecorded:       true,
		ProviderInvoiceLinked: true,
		GifterMemberLinked:    true,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	body := string(encoded)
	for _, forbidden := range []string{
		"tenant_id",
		"purchaser_email",
		"recipient_email",
		`"message"`,
		"stripe_invoice_id",
		"stripe_payment_url",
		"redemption_url",
		"cancel_reason",
		"gifter_subscriber_id",
		"gifter_attribution_token",
		"redeemed_by_subscriber_id",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("projection leaked %q: %s", forbidden, body)
		}
	}
}

func TestGiftHistoryLabelsAreDisplaySafe(t *testing.T) {
	if got := giftHistoryLabel("11111111-1111-4111-8111-111111111111"); got != "Gift record 11111111" {
		t.Fatalf("gift label = %q", got)
	}
	cases := map[string]string{
		"studio-annual":     "Studio Annual",
		"pro_yearly":        "Pro Yearly",
		"price_1ABCsecret":  "Plan on record",
		"arbitrary-plan-id": "Plan on record",
		" unsafe\ncontrol ": "Plan on record",
		"":                  "Plan on record",
	}
	for input, want := range cases {
		if got := giftHistoryPlanLabel(input); got != want {
			t.Errorf("giftHistoryPlanLabel(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestGiftHistoryQueryIsBoundedAndAllowListed(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/gift-subscriptions?limit=48&offset=96&filter=closed&sort=duration&q=Gift%20record%2011111111",
		nil,
	)
	query, err := giftHistoryQueryFromRequest(req)
	if err != nil {
		t.Fatalf("parse valid query: %v", err)
	}
	if query.Limit != 48 || query.Offset != 96 || query.Filter != "closed" ||
		query.Sort != "duration" || query.Search != "11111111" {
		t.Fatalf("unexpected query: %#v", query)
	}
	for _, path := range []string{
		"/api/v1/gift-subscriptions?limit=101",
		"/api/v1/gift-subscriptions?offset=-1",
		"/api/v1/gift-subscriptions?filter=provider",
		"/api/v1/gift-subscriptions?sort=email",
		"/api/v1/gift-subscriptions?sort=plan",
		"/api/v1/gift-subscriptions?q=1234567",
		"/api/v1/gift-subscriptions?q=not-a-record-prefix",
		"/api/v1/gift-subscriptions?q=percent%25wildcard",
		"/api/v1/gift-subscriptions?q=" + strings.Repeat("x", maxGiftHistoryQuery+1),
	} {
		if _, err := giftHistoryQueryFromRequest(httptest.NewRequest(http.MethodGet, path, nil)); err == nil {
			t.Errorf("expected invalid query rejection for %s", path)
		}
	}
}

func TestGiftHistorySearchUsesIndexableUUIDBounds(t *testing.T) {
	prefix, ok := giftHistorySearchPrefix(
		" Gift record 11111111-2222-4333-8444-555555555555 ",
	)
	if !ok || prefix != "11111111222243338444555555555555" {
		t.Fatalf("normalized prefix = %q, ok = %t", prefix, ok)
	}
	lower, upper := giftHistoryIDBounds("11111111")
	if lower != "11111111-0000-0000-0000-000000000000" {
		t.Fatalf("lower bound = %q", lower)
	}
	if upper != "11111111-ffff-ffff-ffff-ffffffffffff" {
		t.Fatalf("upper bound = %q", upper)
	}
	where, args := appendGiftHistoryFilter(
		[]string{"tenant_id = $1::uuid"},
		[]any{"tenant"},
		GiftHistoryQuery{Search: "11111111", Filter: "all"},
	)
	if got := strings.Join(where, " AND "); !strings.Contains(
		got,
		"id BETWEEN $2::uuid AND $3::uuid",
	) {
		t.Fatalf("search predicate is not an indexable UUID range: %s", got)
	}
	if len(args) != 3 || args[1] != lower || args[2] != upper {
		t.Fatalf("search args = %#v", args)
	}
}

func TestGiftHistoryConversionRateUsesEveryTerminalOutcome(t *testing.T) {
	if got := giftHistoryConversionRate(6, 1, 1, 2); got != 0.6 {
		t.Fatalf("conversion rate = %v, want 0.6", got)
	}
	if got := giftHistoryConversionRate(0, 0, 0, 0); got != 0 {
		t.Fatalf("empty conversion rate = %v, want 0", got)
	}
}

func TestMountedGiftArchiveIsExactlyThreeReads(t *testing.T) {
	router := chi.NewRouter()
	repo := &Repo{}
	(&Deps{Repo: repo}).MountRoutes(router)
	(&GiftHandlers{Repo: repo}).MountGiftRoutes(router)

	var routes []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		routes = append(routes, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(routes)
	want := []string{
		"GET /api/v1/gift-subscriptions",
		"GET /api/v1/gift-subscriptions/{id}",
		"GET /api/v1/gift-subscriptions/stats",
	}
	sort.Strings(want)
	if !reflect.DeepEqual(routes, want) {
		t.Fatalf("mounted routes = %#v, want %#v", routes, want)
	}
}

func TestGiftDetailRejectsInvalidIdentifierBeforeDatabase(t *testing.T) {
	handler := &GiftHandlers{Repo: &Repo{}}
	req := reqWithIDAndTenant(http.MethodGet, "not-a-uuid", "")
	recorder := httptest.NewRecorder()
	handler.Detail(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestGiftDetailIdentifierIsCanonicalizedBeforeDatabase(t *testing.T) {
	const canonical = "11111111-1111-4111-8111-111111111111"
	for _, input := range []string{
		canonical,
		"11111111111141118111111111111111",
		"{11111111-1111-4111-8111-111111111111}",
		"urn:uuid:11111111-1111-4111-8111-111111111111",
	} {
		got, err := canonicalGiftHistoryID(input)
		if err != nil {
			t.Fatalf("canonicalize %q: %v", input, err)
		}
		if got != canonical {
			t.Fatalf("canonicalize %q = %q, want %q", input, got, canonical)
		}
	}
}

func TestGiftListRejectsInvalidQueryBeforeDatabase(t *testing.T) {
	deps := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/gift-subscriptions?sort=recipient_email",
		nil,
	)
	req = req.WithContext(middleware.WithTenant(
		req.Context(),
		&middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"},
	))
	recorder := httptest.NewRecorder()
	deps.ListGifts(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestMountedGiftArchiveDenialsAreNoStore(t *testing.T) {
	router := chi.NewRouter()
	repo := &Repo{}
	(&Deps{Repo: repo}).MountRoutes(router)
	(&GiftHandlers{Repo: repo}).MountGiftRoutes(router)

	for _, path := range []string{
		"/api/v1/gift-subscriptions",
		"/api/v1/gift-subscriptions/stats",
		"/api/v1/gift-subscriptions/11111111-1111-4111-8111-111111111111",
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code < http.StatusBadRequest {
			t.Fatalf("%s unexpectedly returned status %d", path, recorder.Code)
		}
		if got := recorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
			t.Fatalf("%s Cache-Control = %q, want a no-store directive", path, got)
		}
	}
}
