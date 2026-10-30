package discounts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type testStripeBridge struct{}

func (testStripeBridge) UpsertCoupon(context.Context, string, CreateInput) (string, string, error) {
	return "coupon_test", "promo_test", nil
}

func (testStripeBridge) DeleteCoupon(context.Context, string, string, string) error {
	return nil
}

func intp(i int) *int { return &i }

func TestValidate(t *testing.T) {
	cases := []struct {
		name string
		in   CreateInput
		ok   bool
	}{
		{"percent ok", CreateInput{Code: "X", PercentOff: intp(10), AppliesTo: AppliesBoth}, true},
		{"amount ok", CreateInput{Code: "X", AmountOffCents: intp(500), AppliesTo: AppliesFirstPayment}, true},
		{"both forbidden", CreateInput{Code: "X", PercentOff: intp(10), AmountOffCents: intp(5), AppliesTo: AppliesBoth}, false},
		{"neither forbidden", CreateInput{Code: "X", AppliesTo: AppliesBoth}, false},
		{"empty code", CreateInput{PercentOff: intp(10), AppliesTo: AppliesBoth}, false},
		{"bad applies_to", CreateInput{Code: "X", PercentOff: intp(10), AppliesTo: "later"}, false},
		{"percent out of range", CreateInput{Code: "X", PercentOff: intp(150), AppliesTo: AppliesBoth}, false},
		{"max redemptions zero", CreateInput{Code: "X", PercentOff: intp(10), AppliesTo: AppliesBoth, MaxRedemptions: intp(0)}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.in.Validate()
			if c.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !c.ok && err == nil {
				t.Fatalf("want error, got ok")
			}
		})
	}
}

func TestCreateAndDeleteFailClosedWithoutStripeBridge(t *testing.T) {
	repo := &Repo{}
	_, err := repo.Create(context.Background(), nil, "tenant", CreateInput{
		Code: "SAFE10", PercentOff: intp(10), AppliesTo: AppliesBoth,
	})
	if !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("Create error = %v, want ErrStripeBridgeUnavailable", err)
	}
	if err := repo.Delete(context.Background(), nil, "tenant", "SAFE10"); !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("Delete error = %v, want ErrStripeBridgeUnavailable", err)
	}
}

// The mounted surface, pinned exactly.
//
// The set is exact so a compiled handler cannot silently become a production
// capability. Codes, PII, live checks, exports, mutations, coupon issuance, and
// pool inventory all remain outside this archive boundary.
func TestMountRoutesMountsExactlyTheReleasedSurface(t *testing.T) {
	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)

	got := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	want := map[string]bool{
		http.MethodGet + " /api/v1/discounts":                         true,
		http.MethodGet + " /api/v1/discounts/{record_id}/redemptions": true,
	}
	// Named withholds keep the exact-count assertion legible and pin every stale
	// route the web administration screen previously advertised.
	for _, withheld := range []string{
		http.MethodGet + " /api/v1/discounts/coupon-pools",
		http.MethodPost + " /api/v1/discounts/coupon-pools",
		http.MethodPost + " /api/v1/discounts/{code}/redeem",
		http.MethodGet + " /api/v1/discounts/{code}/check",
		http.MethodGet + " /api/v1/discounts/{code}/redemptions.csv",
		http.MethodPatch + " /api/v1/discounts/{code}",
		http.MethodDelete + " /api/v1/discounts/{code}",
	} {
		if got[withheld] {
			t.Fatalf("withheld discount route %q is mounted", withheld)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("mounted routes = %#v, want exactly %#v", got, want)
	}
	for route := range want {
		if !got[route] {
			t.Fatalf("missing released route %q; got %#v", route, got)
		}
	}
	for route := range got {
		if !strings.HasPrefix(route, http.MethodGet+" ") {
			t.Fatalf("mutation route mounted on read-only archive: %q", route)
		}
	}
}

func TestHistoricalProjectionOmitsCodesProviderIDsAndTenant(t *testing.T) {
	row := historicalDiscountRecord(Discount{
		ID:             "11111111-1111-4111-8111-111111111111",
		TenantID:       "tenant-secret",
		Code:           "LIVE-COUPON-SECRET",
		StripeCouponID: "stripe-coupon-secret",
		StripePromoID:  "stripe-promo-secret",
		PercentOff:     intp(20),
		AppliesTo:      AppliesBoth,
	})
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal archive projection: %v", err)
	}
	body := string(raw)
	for _, forbidden := range []string{
		"LIVE-COUPON-SECRET",
		"tenant-secret",
		"stripe-coupon-secret",
		"stripe-promo-secret",
		`"code"`,
		`"tenant_id"`,
		`"stripe_coupon_id"`,
		`"stripe_promo_id"`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("archive projection leaked %q: %s", forbidden, body)
		}
	}
	if row.Label != "Discount record 11111111" {
		t.Fatalf("label = %q", row.Label)
	}
}

func TestHistoricalRedemptionProjectionOmitsIdentity(t *testing.T) {
	raw, err := json.Marshal(HistoricalRedemptionEvent{
		RedeemedAt:       time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC),
		SubscriberLinked: true,
	})
	if err != nil {
		t.Fatalf("marshal historical event: %v", err)
	}
	body := string(raw)
	for _, forbidden := range []string{
		`"id"`,
		`"tenant_id"`,
		`"discount_id"`,
		`"discount_code"`,
		`"subscriber_id"`,
		`"subscriber_email"`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("historical event leaked %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"subscriber_linked":true`) {
		t.Fatalf("historical event omitted linkage boolean: %s", body)
	}
}

func TestArchivePaginationIsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		name     string
		query    string
		key      string
		fallback int
		min      int
		max      int
		want     int
		wantErr  bool
	}{
		{name: "default", key: "limit", fallback: 50, min: 1, max: 100, want: 50},
		{name: "lower bound", query: "?limit=1", key: "limit", fallback: 50, min: 1, max: 100, want: 1},
		{name: "upper bound", query: "?limit=100", key: "limit", fallback: 50, min: 1, max: 100, want: 100},
		{name: "zero limit", query: "?limit=0", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "explicit empty", query: "?limit=", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "plus decoded as space", query: "?limit=+", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "surrounding whitespace", query: "?limit=%201", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "duplicate", query: "?limit=1&limit=2", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "leading zero", query: "?limit=01", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "negative", query: "?offset=-1", key: "offset", min: 0, max: 10000, wantErr: true},
		{name: "fraction", query: "?limit=2.5", key: "limit", fallback: 50, min: 1, max: 100, wantErr: true},
		{name: "oversized", query: "?offset=10001", key: "offset", min: 0, max: 10000, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts"+tc.query, nil)
			got, err := archiveIntParam(req, tc.key, tc.fallback, tc.min, tc.max)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("archiveIntParam() = %d, want error", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("archiveIntParam() = (%d, %v), want (%d, nil)", got, err, tc.want)
			}
		})
	}
}

func TestArchiveRecordIDAndQueryAreCanonical(t *testing.T) {
	const recordID = "11111111-2222-4333-8444-555555555555"
	for _, tc := range []struct {
		name    string
		query   string
		want    string
		wantErr bool
	}{
		{name: "absent"},
		{name: "canonical", query: "?record_id=" + recordID, want: recordID},
		{name: "uppercase", query: "?record_id=11111111-2222-4333-8444-55555555555A", wantErr: true},
		{name: "padded", query: "?record_id=%20" + recordID, wantErr: true},
		{name: "empty", query: "?record_id=", wantErr: true},
		{name: "duplicate", query: "?record_id=" + recordID + "&record_id=" + recordID, wantErr: true},
		{name: "code shaped", query: "?record_id=SAVE20", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts"+tc.query, nil)
			got, err := archiveOptionalUUIDParam(req, "record_id")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("archiveOptionalUUIDParam() = %q, want error", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("archiveOptionalUUIDParam() = (%q, %v), want (%q, nil)", got, err, tc.want)
			}
		})
	}

	for _, raw := range []string{recordID, "11111111-2222-4333-8444-55555555555A"} {
		got, err := canonicalArchiveUUID(raw)
		if raw == recordID {
			if err != nil || got != recordID {
				t.Fatalf("canonicalArchiveUUID(%q) = (%q, %v)", raw, got, err)
			}
		} else if err == nil {
			t.Fatalf("canonicalArchiveUUID(%q) unexpectedly accepted", raw)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts?q=SECRET20", nil)
	if err := archiveQueryKeys(req, "limit", "offset", "record_id"); err == nil {
		t.Fatal("legacy code-search query unexpectedly accepted")
	}
}

func TestArchiveHandlersMarkErrorsNoStore(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		path    string
	}{
		{name: "list unauthorized", handler: (&Deps{}).List, path: "/api/v1/discounts"},
		{name: "events unauthorized", handler: (&Deps{}).ListRedemptions, path: "/api/v1/discounts/not-an-id/redemptions"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.handler(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
		})
	}

	rec := httptest.NewRecorder()
	discountHistoryNoStore(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusForbidden || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("wrapped denial = status %d cache %q", rec.Code, rec.Header().Get("Cache-Control"))
	}

	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/discounts", nil))
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("mounted auth denial = status %d cache %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestListRejectsMalformedPaginationBeforeRepositoryAccess(t *testing.T) {
	deps := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts?limit=all", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"}))
	rec := httptest.NewRecorder()

	deps.List(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_pagination") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestListRedemptionsRejectsRedeemableCodePathValue(t *testing.T) {
	deps := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts/LIVE20/redemptions", nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("record_id", "LIVE20")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"}))
	rec := httptest.NewRecorder()

	deps.ListRedemptions(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "LIVE20") {
		t.Fatalf("response echoed redeemable code: %s", rec.Body.String())
	}
}

func TestListRedemptionsRejectsNonCanonicalUUIDPath(t *testing.T) {
	deps := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/discounts/ID/redemptions", nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("record_id", "11111111-2222-4333-8444-55555555555A")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"}))
	rec := httptest.NewRecorder()

	deps.ListRedemptions(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_record_id") {
		t.Fatalf("response = %d %s, want canonical-ID 400", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestCouponAllocationAvailabilityIsFailClosed(t *testing.T) {
	if CouponAllocationAvailable {
		t.Fatal("coupon allocation must remain unavailable until release qualification")
	}
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"code":"` + strings.Repeat("x", int(discountJSONMaxBodyBytes)) + `","percent_off":10,"applies_to":"both"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/discounts", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.Create(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCheckRedeemable(t *testing.T) {
	now := time.Date(2026, 5, 3, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)

	cases := []struct {
		name string
		d    *Discount
		ok   bool
		why  string
	}{
		{"nil", nil, false, "unknown_code"},
		{"healthy", &Discount{Code: "A"}, true, ""},
		{"expired", &Discount{Code: "A", ExpiresAt: &past}, false, "expired"},
		{"future expiry", &Discount{Code: "A", ExpiresAt: &future}, true, ""},
		{"max reached", &Discount{Code: "A", MaxRedemptions: intp(2), TimesRedeemed: 2}, false, "max_redemptions_reached"},
		{"max not reached", &Discount{Code: "A", MaxRedemptions: intp(2), TimesRedeemed: 1}, true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, why := CheckRedeemable(c.d, now)
			if ok != c.ok || why != c.why {
				t.Fatalf("want (%v,%q), got (%v,%q)", c.ok, c.why, ok, why)
			}
		})
	}
}

func TestCouponPoolInputValidation(t *testing.T) {
	if err := (&CouponPoolInput{Name: "VIP", CodeType: CouponPoolStatic, DefaultCode: "save10"}).NormalizeAndValidate(); err != nil {
		t.Fatalf("static pool validate: %v", err)
	}
	in := CouponPoolInput{Name: "Unique welcome"}
	if err := (&in).NormalizeAndValidate(); err != nil {
		t.Fatalf("default imported pool validate: %v", err)
	}
	if in.CodeType != CouponPoolImported || in.Status != CouponPoolActive || in.Provider != "postwave" {
		t.Fatalf("defaults = %#v", in)
	}
	if err := (&CouponPoolInput{Name: "Broken", CodeType: CouponPoolStatic}).NormalizeAndValidate(); err == nil {
		t.Fatalf("expected static pool without code to fail")
	}
}

func TestCouponCodeImportNormalizesAndDedupes(t *testing.T) {
	in := CouponCodeImportInput{Codes: []string{" save10 ", "SAVE10", "", "Vip20"}}
	codes, err := (&in).NormalizeAndValidate()
	if err != nil {
		t.Fatalf("NormalizeAndValidate: %v", err)
	}
	got := strings.Join(codes, ",")
	if got != "SAVE10,VIP20" {
		t.Fatalf("codes = %q", got)
	}
}

func TestCouponAssignmentValidationRequiresSubscriber(t *testing.T) {
	in := CouponAssignmentInput{ContextKey: ""}
	if err := (&in).NormalizeAndValidate(); err == nil {
		t.Fatalf("expected missing subscriber to fail")
	}
	in = CouponAssignmentInput{SubscriberEmail: " Buyer@Example.COM "}
	if err := (&in).NormalizeAndValidate(); err != nil {
		t.Fatalf("valid assignment: %v", err)
	}
	if in.SubscriberEmail != "buyer@example.com" || in.ContextKey != "default" {
		t.Fatalf("normalized assignment = %#v", in)
	}
}

// TestRepoList_QFilter inserts 5 discounts with mixed codes and asserts
// that List(q) filters by code substring (case-insensitive).
// Skips silently when DATABASE_URL is unset.
func TestRepoList_QFilter(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := seedDiscountTenant(t, ctx, pool)
	tag := strings.ToUpper(randHex4Disc(t))
	prefix := "QF" + tag
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupDiscounts(pool, tenantID, prefix) })

	codes := []string{
		prefix + "ALPHA",
		prefix + "ALPHABET",
		prefix + "BETA",
		prefix + "GAMMA",
		prefix + "DELTA",
	}
	for _, code := range codes {
		if _, err := repo.Create(ctx, testStripeBridge{}, tenantID, CreateInput{
			Code: code, PercentOff: intp(10), AppliesTo: AppliesBoth,
		}); err != nil {
			t.Fatalf("seed %q: %v", code, err)
		}
	}

	got, err := repo.List(ctx, tenantID, prefix+"alpha")
	if err != nil {
		t.Fatalf("List q: %v", err)
	}
	matched := 0
	for _, d := range got {
		if strings.HasPrefix(d.Code, prefix) {
			matched++
		}
	}
	if matched != 2 {
		t.Fatalf("q=%s: matched %d, want 2 (got=%v)", prefix+"alpha", matched, got)
	}
}

func TestRepoHistoricalArchiveIsBoundedCanonicalAndTenantScoped(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantA := seedDiscountTenant(t, ctx, pool)
	tenantB := seedDiscountTenant(t, ctx, pool)
	recordA := seedHistoricalDiscount(t, ctx, pool, tenantA, "ARCHIVE-A", "usd")
	invalidCurrencyRecord := seedHistoricalDiscount(t, ctx, pool, tenantA, "ARCHIVE-B", " bad currency ")
	recordB := seedHistoricalDiscount(t, ctx, pool, tenantB, "ARCHIVE-C", "usd")
	repo := &Repo{Pool: pool}

	items, hasMore, err := repo.ListHistoricalRecords(ctx, tenantA, "", 1, 0)
	if err != nil {
		t.Fatalf("ListHistoricalRecords page: %v", err)
	}
	if len(items) != 1 || !hasMore {
		t.Fatalf("bounded page = (%d items, hasMore=%v), want (1,true)", len(items), hasMore)
	}

	items, hasMore, err = repo.ListHistoricalRecords(ctx, tenantA, invalidCurrencyRecord, 1, 0)
	if err != nil {
		t.Fatalf("ListHistoricalRecords point lookup: %v", err)
	}
	if len(items) != 1 || hasMore || items[0].ID != invalidCurrencyRecord || items[0].Currency != "XXX" {
		t.Fatalf("normalized point lookup = %#v, hasMore=%v", items, hasMore)
	}

	items, hasMore, err = repo.ListHistoricalRecords(ctx, tenantA, recordB, 1, 0)
	if err != nil {
		t.Fatalf("cross-tenant point lookup: %v", err)
	}
	if len(items) != 0 || hasMore {
		t.Fatalf("cross-tenant record leaked: %#v, hasMore=%v", items, hasMore)
	}
	if _, err := repo.ListHistoricalRedemptionEvents(ctx, tenantA, recordB, 50, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant timeline error = %v, want ErrNotFound", err)
	}
	if _, err := repo.ListHistoricalRedemptionEvents(ctx, tenantA, "{"+recordA+"}", 50, 0); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("noncanonical timeline error = %v, want ErrInvalidInput", err)
	}
}

func seedHistoricalDiscount(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, code, currency string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin discount seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO discounts (tenant_id, code, percent_off, currency, applies_to)
VALUES ($1::uuid, $2, 20, $3, 'both')
RETURNING id::text`, tenantID, code+randHex4Disc(t), currency).Scan(&id); err != nil {
		t.Fatalf("seed historical discount: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit historical discount: %v", err)
	}
	return id
}

func randHex4Disc(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func seedDiscountTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Discount q-filter test', 'studio')`,
		tenantID, "discount-qfilter-"+randHex4Disc(t)); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
	return tenantID
}

func cleanupDiscounts(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM discounts WHERE tenant_id = $1::uuid AND code LIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
