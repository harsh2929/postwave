// SPDX-License-Identifier: AGPL-3.0-only
//
// pnl_test.go — pure-function + handler tests for the Segment P&L
// surface. Runs WITHOUT a live database: persistence is behind the
// PnLStore interface and a fake store provides fixtures. The economic
// formulas (net contribution, CLV ratio, per-member, lift partition) are
// table-tested directly — a wrong formula is invisible in integration
// tests, so these are first-class here.
package segments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---------------------------------------------------------------------------
// Pure formula tests
// ---------------------------------------------------------------------------

func TestComputeNetContribution(t *testing.T) {
	// Spec example: revenue=5000, unsubs=10 @200, complaints=2 @500 →
	// 5000 - (10*200) - (2*500) = 5000 - 2000 - 1000 = 2000.
	got := computeNetContributionCents(5000, 10, 200, 2, 500)
	if got != 2000 {
		t.Fatalf("net = %d, want 2000", got)
	}
	// No cost config (zero costs) → net == revenue.
	if got := computeNetContributionCents(5000, 10, 0, 2, 0); got != 5000 {
		t.Fatalf("net (zero cost) = %d, want 5000", got)
	}
	// Costs exceed revenue → negative net (honest, not clamped).
	if got := computeNetContributionCents(100, 10, 50, 0, 0); got != -400 {
		t.Fatalf("net (loss) = %d, want -400", got)
	}
}

func TestComputeCLVRatio(t *testing.T) {
	cases := []struct {
		name           string
		historic, pred int64
		wantNil        bool
		want           float64
	}{
		{"both non-zero", 600, 1000, false, 0.6},
		{"realised over predicted", 1200, 1000, false, 1.2},
		{"predicted zero → nil", 500, 0, true, 0},
		{"predicted negative → nil", 500, -10, true, 0},
		{"historic zero, predicted positive", 0, 1000, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := computeCLVRatio(tc.historic, tc.pred)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("ratio = %v, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("ratio = nil, want %v", tc.want)
			}
			if *got != tc.want {
				t.Fatalf("ratio = %v, want %v", *got, tc.want)
			}
		})
	}
}

func TestComputePerMemberCents(t *testing.T) {
	if got := computePerMemberCents(1000, 4); got == nil || *got != 250 {
		t.Fatalf("perMember = %v, want 250", got)
	}
	// Zero members → nil (no honest denominator), never a fake 0.
	if got := computePerMemberCents(1000, 0); got != nil {
		t.Fatalf("perMember (0 members) = %v, want nil", *got)
	}
	// Negative net divides honestly.
	if got := computePerMemberCents(-400, 2); got == nil || *got != -200 {
		t.Fatalf("perMember (loss) = %v, want -200", got)
	}
}

func TestParsePnLDays(t *testing.T) {
	cases := []struct {
		raw    string
		want   int
		wantOK bool
	}{
		{"", 90, true},
		{"30", 30, true},
		{"365", 365, true},
		{"1", 1, true},
		{"0", 0, false},
		{"366", 0, false},
		{"-5", 0, false},
		{"abc", 0, false},
		{"30d", 0, false},
	}
	for _, tc := range cases {
		got, ok := parsePnLDays(tc.raw)
		if got != tc.want || ok != tc.wantOK {
			t.Fatalf("parsePnLDays(%q) = (%d,%v), want (%d,%v)", tc.raw, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestPnLDominantCurrency(t *testing.T) {
	// Empty → "".
	if got := pnlDominantCurrency(nil); got != "" {
		t.Fatalf("dominant(nil) = %q, want empty", got)
	}
	// Most revenue wins.
	totals := []PnLCurrencyTotal{
		{Currency: "EUR", Conversions: 100, RevenueCents: 5000},
		{Currency: "USD", Conversions: 2, RevenueCents: 9000},
	}
	if got := pnlDominantCurrency(totals); got != "USD" {
		t.Fatalf("dominant = %q, want USD", got)
	}
	// Tie on revenue → most conversions; then alphabetical.
	tie := []PnLCurrencyTotal{
		{Currency: "GBP", Conversions: 5, RevenueCents: 1000},
		{Currency: "CAD", Conversions: 5, RevenueCents: 1000},
	}
	if got := pnlDominantCurrency(tie); got != "CAD" {
		t.Fatalf("dominant(tie) = %q, want CAD (alphabetical)", got)
	}
}

func TestParseCompareIDs(t *testing.T) {
	got := parseCompareIDs(" a , b ,, a , c ")
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if len(parseCompareIDs("")) != 0 {
		t.Fatalf("empty should yield no ids")
	}
}

func TestBoolParam(t *testing.T) {
	for _, truthy := range []string{"1", "true", "TRUE", "yes", "on"} {
		if !boolParam(truthy) {
			t.Fatalf("boolParam(%q) = false, want true", truthy)
		}
	}
	for _, falsy := range []string{"", "0", "false", "no", "off", "maybe"} {
		if boolParam(falsy) {
			t.Fatalf("boolParam(%q) = true, want false", falsy)
		}
	}
}

// ---------------------------------------------------------------------------
// Lift computation — verifies the partition matches holdout.AssignBucket
// determinism and the rate delta is correct.
// ---------------------------------------------------------------------------

func TestLiftFromCohorts(t *testing.T) {
	seed := "seg-holdout:seg-1"
	percent := 20.0 // buckets 0..19 held out (control)

	// Build a deterministic member set; classify each via AssignBucket so
	// the test's expectations track the production hash exactly.
	members := []string{}
	convertedControl, convertedTreated := 0, 0
	converted := map[string]bool{}
	var wantControl, wantTreated int64
	for i := 0; i < 200; i++ {
		id := "sub-" + string(rune('A'+(i%26))) + itoa(i)
		members = append(members, id)
		held := holdout.IsHeldOut(seed, id, percent)
		if held {
			wantControl++
		} else {
			wantTreated++
		}
		// Make treated convert more often than control so lift is positive:
		// convert every treated with even index, every control with index%5.
		if held {
			if i%5 == 0 {
				converted[id] = true
				convertedControl++
			}
		} else {
			if i%2 == 0 {
				converted[id] = true
				convertedTreated++
			}
		}
	}

	res := liftFromCohorts(seed, percent, 90, members, converted)
	if res == nil {
		t.Fatal("lift = nil, want a result")
	}
	if res.ControlSize != wantControl || res.TreatedSize != wantTreated {
		t.Fatalf("cohorts = (control %d, treated %d), want (control %d, treated %d)",
			res.ControlSize, res.TreatedSize, wantControl, wantTreated)
	}
	wantControlRate := pnlSafeRate(int64(convertedControl), wantControl)
	wantTreatedRate := pnlSafeRate(int64(convertedTreated), wantTreated)
	if res.ControlConvRate != wantControlRate || res.TreatedConvRate != wantTreatedRate {
		t.Fatalf("rates = (%v, %v), want (%v, %v)",
			res.ControlConvRate, res.TreatedConvRate, wantControlRate, wantTreatedRate)
	}
	if res.IncrementalLift != wantTreatedRate-wantControlRate {
		t.Fatalf("incremental = %v, want %v", res.IncrementalLift, wantTreatedRate-wantControlRate)
	}
}

func TestLiftFromCohortsEmpty(t *testing.T) {
	if res := liftFromCohorts("seed", 10, 90, nil, nil); res != nil {
		t.Fatalf("empty member set should yield nil lift, got %+v", res)
	}
}

func TestLiftConfidenceLow(t *testing.T) {
	// Tiny cohorts → confidence_low true.
	members := []string{"a", "b", "c"}
	res := liftFromCohorts("s", 50, 90, members, map[string]bool{"a": true})
	if res == nil || !res.ConfidenceLow {
		t.Fatalf("expected confidence_low=true for tiny cohorts, got %+v", res)
	}
}

// ---------------------------------------------------------------------------
// assemblePnL — honest-gap flags + net-contribution currency guard.
// ---------------------------------------------------------------------------

func TestAssemblePnLHonestGaps(t *testing.T) {
	now := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	raw := &PnLRawData{
		SegmentID:            "seg-1",
		MemberCount:          1000,
		Currencies:           []PnLCurrencyTotal{{Currency: "USD", Conversions: 40, RevenueCents: 50000}, {Currency: "EUR", Conversions: 3, RevenueCents: 9000}},
		DominantCurrency:     "USD",
		RevenueCents:         50000,
		RevenueConversions:   40,
		HasOrders:            true,
		AOVCents:             1250,
		AOVOrderCount:        40,
		AOVCurrency:          "USD",
		CLVMembersScored:     340,
		CLVHistoricSumCents:  600000,
		CLVPredictedSumCents: 1000000,
		UnsubCount:           10,
		ComplaintCount:       2,
		UnsubCostCents:       200,
		ComplaintCostCents:   500,
		CostCurrency:         "USD",
		CostConfigPresent:    true,
	}
	out := assemblePnL(raw, 90, nil, "", now)

	if !out.SequenceAttributionUnsupported {
		t.Fatal("sequence_attribution_unsupported must always be true")
	}
	if !out.CrossCurrencyRevenueExcluded {
		t.Fatal("cross_currency_revenue_excluded must be true with >1 currency")
	}
	if out.RevenueScope != "member_all_sources" {
		t.Fatalf("revenue_scope = %q, want member_all_sources", out.RevenueScope)
	}
	if out.AOVCents == nil || *out.AOVCents != 1250 {
		t.Fatalf("aov = %v, want 1250", out.AOVCents)
	}
	// Net = 50000 - (10*200) - (2*500) = 47000.
	if out.NetContributionCents == nil || *out.NetContributionCents != 47000 {
		t.Fatalf("net = %v, want 47000", out.NetContributionCents)
	}
	// Per member = 47000 / 1000 = 47.
	if out.NetContributionPerMemberCents == nil || *out.NetContributionPerMemberCents != 47 {
		t.Fatalf("net/member = %v, want 47", out.NetContributionPerMemberCents)
	}
	// CLV ratio = 600000/1000000 = 0.6.
	if out.CLVRealisedVsPredicted == nil || *out.CLVRealisedVsPredicted != 0.6 {
		t.Fatalf("clv ratio = %v, want 0.6", out.CLVRealisedVsPredicted)
	}
	if !out.GeneratedAt.Equal(now) {
		t.Fatalf("generated_at = %v, want %v", out.GeneratedAt, now)
	}
}

func TestAssemblePnLCrossCurrencyNetNil(t *testing.T) {
	now := time.Now().UTC()
	raw := &PnLRawData{
		SegmentID:         "seg-1",
		MemberCount:       100,
		Currencies:        []PnLCurrencyTotal{{Currency: "EUR", Conversions: 5, RevenueCents: 9000}},
		DominantCurrency:  "EUR",
		RevenueCents:      9000,
		UnsubCount:        3,
		UnsubCostCents:    100,
		CostCurrency:      "USD", // differs from revenue EUR
		CostConfigPresent: true,
	}
	out := assemblePnL(raw, 90, nil, "", now)
	if out.NetContributionCents != nil {
		t.Fatalf("net must be nil when revenue currency != cost currency, got %d", *out.NetContributionCents)
	}
	if out.NetContributionPerMemberCents != nil {
		t.Fatalf("net/member must be nil under cross-currency, got %v", out.NetContributionPerMemberCents)
	}
}

func TestAssemblePnLNoOrdersAOVNil(t *testing.T) {
	out := assemblePnL(&PnLRawData{SegmentID: "s", MemberCount: 10, HasOrders: false}, 90, nil, "", time.Now())
	if out.AOVCents != nil {
		t.Fatalf("aov must be nil with no orders, got %d", *out.AOVCents)
	}
}

// ---------------------------------------------------------------------------
// Fake store + handler tests (no DB).
// ---------------------------------------------------------------------------

type fakePnLStore struct {
	raw        map[string]*PnLRawData
	memberIDs  map[string][]string
	converted  map[string]map[string]bool
	upsertErr  error
	deleteErr  error
	lastUpsert *SegmentHoldoutConfig
}

func (f *fakePnLStore) SegmentPnLRaw(_ context.Context, _, segmentID string, _ int) (*PnLRawData, error) {
	raw, ok := f.raw[segmentID]
	if !ok {
		return nil, ErrNotFound
	}
	return raw, nil
}

func (f *fakePnLStore) SegmentLiftCohorts(_ context.Context, _, segmentID string, _ int) ([]string, map[string]bool, error) {
	return f.memberIDs[segmentID], f.converted[segmentID], nil
}

func (f *fakePnLStore) UpsertSegmentHoldout(_ context.Context, _, segmentID string, percent float64, windowDays int) (*SegmentHoldoutConfig, error) {
	if f.upsertErr != nil {
		return nil, f.upsertErr
	}
	cfg := &SegmentHoldoutConfig{SegmentID: segmentID, Percent: percent, Seed: "seg-holdout:" + segmentID, WindowDays: windowDays, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	f.lastUpsert = cfg
	return cfg, nil
}

func (f *fakePnLStore) DeleteSegmentHoldout(_ context.Context, _, _ string) error {
	return f.deleteErr
}

func TestComputeSegmentPnLLiftSkippedNoHoldout(t *testing.T) {
	store := &fakePnLStore{raw: map[string]*PnLRawData{
		"seg-1": {SegmentID: "seg-1", MemberCount: 50, HasHoldout: false, CostCurrency: "USD"},
	}}
	out, err := computeSegmentPnL(context.Background(), store, "ten", "seg-1", 90, true, time.Now())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out.Lift != nil {
		t.Fatal("lift must be nil with no holdout")
	}
	if out.LiftSkippedReason != "no_holdout_configured" {
		t.Fatalf("reason = %q, want no_holdout_configured", out.LiftSkippedReason)
	}
}

func TestComputeSegmentPnLLiftSkippedTooLarge(t *testing.T) {
	store := &fakePnLStore{raw: map[string]*PnLRawData{
		"seg-1": {SegmentID: "seg-1", MemberCount: liftInProcessMemberCap + 1, HasHoldout: true, HoldoutSeed: "s", HoldoutPercent: 10, HoldoutWindow: 90},
	}}
	out, err := computeSegmentPnL(context.Background(), store, "ten", "seg-1", 90, true, time.Now())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out.Lift != nil || out.LiftSkippedReason != "segment_too_large_for_in_process_lift" {
		t.Fatalf("expected too-large skip, got lift=%v reason=%q", out.Lift, out.LiftSkippedReason)
	}
}

func TestComputeSegmentPnLLiftComputed(t *testing.T) {
	seed := "seg-holdout:seg-1"
	members := []string{}
	converted := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := "m" + itoa(i)
		members = append(members, id)
		if !holdout.IsHeldOut(seed, id, 20) && i%2 == 0 {
			converted[id] = true
		}
	}
	store := &fakePnLStore{
		raw: map[string]*PnLRawData{
			"seg-1": {SegmentID: "seg-1", MemberCount: 100, HasHoldout: true, HoldoutSeed: seed, HoldoutPercent: 20, HoldoutWindow: 90, CostCurrency: "USD"},
		},
		memberIDs: map[string][]string{"seg-1": members},
		converted: map[string]map[string]bool{"seg-1": converted},
	}
	out, err := computeSegmentPnL(context.Background(), store, "ten", "seg-1", 90, true, time.Now())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out.Lift == nil {
		t.Fatal("lift must be computed when holdout exists and segment is small")
	}
	if out.LiftSkippedReason != "" {
		t.Fatalf("reason should be empty when lift computed, got %q", out.LiftSkippedReason)
	}
	if out.Lift.ControlSize+out.Lift.TreatedSize != 100 {
		t.Fatalf("cohorts should sum to 100, got %d+%d", out.Lift.ControlSize, out.Lift.TreatedSize)
	}
}

func TestComputeSegmentPnLNoLiftWhenNotRequested(t *testing.T) {
	store := &fakePnLStore{raw: map[string]*PnLRawData{
		"seg-1": {SegmentID: "seg-1", MemberCount: 50, HasHoldout: true, HoldoutSeed: "s", HoldoutPercent: 10, HoldoutWindow: 90},
	}}
	out, _ := computeSegmentPnL(context.Background(), store, "ten", "seg-1", 90, false, time.Now())
	if out.Lift != nil || out.LiftSkippedReason != "" {
		t.Fatalf("lift should be untouched when not requested, got lift=%v reason=%q", out.Lift, out.LiftSkippedReason)
	}
}

func TestSegmentPnLHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/pnl", nil)
	req = withChiID(req, "id", "seg-1")
	rec := httptest.NewRecorder()
	d.SegmentPnL(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSegmentPnLHandlerBadDays(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/pnl?days=9999", nil)
	req = withTenant(withChiID(req, "id", "seg-1"))
	rec := httptest.NewRecorder()
	d.SegmentPnL(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_days") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSegmentPnLCompareTooFew(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/pnl/compare?ids=a", nil)
	req = withTenant(req)
	rec := httptest.NewRecorder()
	d.SegmentPnLCompare(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "too_few_segments") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSegmentPnLCompareTooMany(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/pnl/compare?ids=a,b,c,d,e,f", nil)
	req = withTenant(req)
	rec := httptest.NewRecorder()
	d.SegmentPnLCompare(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "too_many_segments") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateSegmentHoldoutBadPercent(t *testing.T) {
	d := &Deps{}
	body := `{"percent": 75, "window_days": 90}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/seg-1/holdout", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withTenant(withChiID(req, "id", "seg-1"))
	rec := httptest.NewRecorder()
	d.CreateSegmentHoldout(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_percent") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// Verifies the response shape serialises with the always-on honest flag.
func TestSegmentPnLResponseAlwaysFlagsSequence(t *testing.T) {
	out := assemblePnL(&PnLRawData{SegmentID: "s", MemberCount: 1, CostCurrency: "USD"}, 90, nil, "", time.Now())
	b, _ := json.Marshal(out)
	if !strings.Contains(string(b), `"sequence_attribution_unsupported":true`) {
		t.Fatalf("serialised body missing always-on flag: %s", string(b))
	}
	if !strings.Contains(string(b), `"revenue_scope":"member_all_sources"`) {
		t.Fatalf("serialised body missing revenue_scope: %s", string(b))
	}
}

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

func withTenant(r *http.Request) *http.Request {
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "ten-1", Slug: "t"})
	return r.WithContext(ctx)
}

func withChiID(r *http.Request, key, val string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, val)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// itoa avoids importing strconv just for a couple of test ids.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
