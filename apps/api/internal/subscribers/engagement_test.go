package subscribers

// Pure-function and real-schema tests for engagement scoring. The DB-backed
// cases exercise loadCounts across campaign_recipients, subscriber_events,
// and conversions so source-ledger, tenant, window, and currency semantics
// stay pinned alongside ComputeScore's formula.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestComputeScore_NoEvents — zero events → zero score (not NaN, not
// negative, not panic). Important: a brand-new tenant returns 0 for
// every subscriber and we render that as "no signal yet" in the UI.
func TestComputeScore_NoEvents(t *testing.T) {
	if got := ComputeScore(EventCounts{}); got != 0 {
		t.Errorf("ComputeScore({}) = %d, want 0", got)
	}
}

// TestComputeScore_OnlyOpens — a single open with zero sends still
// scores something because the denominator clamps to 1. This is the
// "we have a signal but no record of the send (e.g. legacy import)"
// case; we'd rather show low engagement than nothing.
func TestComputeScore_OnlyOpens(t *testing.T) {
	got := ComputeScore(EventCounts{Opens: 1})
	// weighted=1, denom=max(0,1)=1, perfect=9 → 1*100/(1*9) = 11.
	if got != 11 {
		t.Errorf("ComputeScore({Opens:1}) = %d, want 11", got)
	}
}

// TestComputeScore_MixedActivity — opens+clicks weighted as 1+3.
func TestComputeScore_MixedActivity(t *testing.T) {
	// 10 sends, 5 opens, 2 clicks → weighted = 5 + 6 = 11
	// 11*100 / (10*9) = 12.
	got := ComputeScore(EventCounts{Sends: 10, Opens: 5, Clicks: 2})
	if got != 12 {
		t.Errorf("got %d, want 12", got)
	}
}

// TestComputeScore_ClampedHigh — perfect engagement clamps to 100.
func TestComputeScore_ClampedHigh(t *testing.T) {
	// Sends=1 with opens+clicks+replies far above 'perfect' → clamp.
	got := ComputeScore(EventCounts{Sends: 1, Opens: 100, Clicks: 100, Replies: 100})
	if got != 100 {
		t.Errorf("got %d, want 100 (clamped)", got)
	}
}

// TestComputeScore_RepliesDominate — replies weight 5x, so 1 reply
// per send is far higher than 1 click per send.
func TestComputeScore_RepliesDominate(t *testing.T) {
	a := ComputeScore(EventCounts{Sends: 10, Replies: 1})
	b := ComputeScore(EventCounts{Sends: 10, Clicks: 1})
	if a <= b {
		t.Errorf("reply score %d should exceed click score %d", a, b)
	}
}

// TestComputeScore_NegativesNotPossible — guards the clamping branch.
// ComputeScore returns 0 immediately when weighted<=0, so even
// nonsensical (negative) inputs cannot produce a negative result.
func TestComputeScore_WeightedZeroIsZero(t *testing.T) {
	if got := ComputeScore(EventCounts{Sends: 100}); got != 0 {
		t.Errorf("got %d, want 0 when weighted=0", got)
	}
}

// --- SUB-125: per-subscriber Contact Performance Report (revenue) ---

// TestComputeScore_RevenueDoesNotAffectScore — revenue_cents is a
// descriptive performance metric, not a scoring input. Two EventCounts
// identical except for RevenueCents must score the same. This pins the
// contract that adding revenue to the rollup does not perturb the
// engagement score formula.
func TestComputeScore_RevenueDoesNotAffectScore(t *testing.T) {
	base := EventCounts{Sends: 10, Opens: 5, Clicks: 2}
	withRev := base
	withRev.RevenueCents = 1_234_567
	if got, want := ComputeScore(withRev), ComputeScore(base); got != want {
		t.Errorf("revenue changed score: got %d, want %d", got, want)
	}
}

// TestEngagementResult_SerializesRevenueCents — the revenue_cents JSON
// key must be present on the wire (zero value included, not omitempty)
// so the desktop SubscriberEngagementResult type and the Contact
// Performance Report can rely on it always being there.
func TestEngagementResult_SerializesRevenueCents(t *testing.T) {
	res := EngagementResult{
		SubscriberID: "sub-1",
		Email:        "buyer@example.com",
		Score:        42,
		Counts: EventCounts{
			Sends:           3,
			Opens:           2,
			Clicks:          1,
			RevenueCents:    9900,
			RevenueCurrency: "USD",
			RevenueByCurrency: []CurrencyRevenue{
				{Currency: "USD", Conversions: 2, RevenueCents: 9900},
			},
		},
		WindowDays: 90,
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		Counts struct {
			RevenueCents    int64             `json:"revenue_cents"`
			RevenueCurrency string            `json:"revenue_currency"`
			Breakdown       []CurrencyRevenue `json:"revenue_by_currency"`
		} `json:"counts"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Counts.RevenueCents != 9900 {
		t.Errorf("revenue_cents = %d, want 9900; raw=%s", decoded.Counts.RevenueCents, raw)
	}
	if decoded.Counts.RevenueCurrency != "USD" || len(decoded.Counts.Breakdown) != 1 {
		t.Errorf("currency contract = %+v, want USD breakdown; raw=%s", decoded.Counts, raw)
	}
	// Zero value must still serialize the key (non-omitempty).
	rawZero, _ := json.Marshal(EngagementResult{})
	if want := `"revenue_cents":0`; !strings.Contains(string(rawZero), want) {
		t.Errorf("zero-value EngagementResult missing %s; raw=%s", want, rawZero)
	}
}

func TestEngagementCurrencyRegistryIsBoundedAndRecognizesISO(t *testing.T) {
	if len(engagementISOCurrencyCodes) == 0 || len(engagementISOCurrencyCodes) > 512 {
		t.Fatalf("ISO registry size = %d, want bounded non-empty registry", len(engagementISOCurrencyCodes))
	}
	set := make(map[string]bool, len(engagementISOCurrencyCodes))
	for i, code := range engagementISOCurrencyCodes {
		if code == "XXX" {
			t.Fatal("XXX must remain unclassified")
		}
		if len(code) != 3 || code != strings.ToUpper(code) {
			t.Fatalf("non-canonical currency code %q", code)
		}
		if i > 0 && engagementISOCurrencyCodes[i-1] >= code {
			t.Fatalf("currency registry not unique/sorted at %q", code)
		}
		set[code] = true
	}
	for _, code := range []string{"EUR", "INR", "USD"} {
		if !set[code] {
			t.Errorf("ISO registry missing %s", code)
		}
	}
}

// --- SUB-125 DB-backed: loadCounts revenue aggregation ---

func newEngagementTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed engagement revenue test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedEngagementTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'engagement-rev-test', 'engagement-rev-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestEngagement_AggregatesRevenueFromConversions pins SUB-125's simple
// single-currency case: the Engagement repo method (via loadCounts) sums
// conversions.amount_cents for the subscriber over the 90-day window while
// ignoring non-monetary (NULL amount) conversions and out-of-window rows.
func TestEngagement_AggregatesRevenueFromConversions(t *testing.T) {
	pool := newEngagementTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41261"
	seedEngagementTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("buyer-%d@example.test", suffix)

	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	now := time.Now().UTC()
	// In-window monetary conversions: 9900 + 100 = 10000.
	// One non-monetary (NULL amount) and one out-of-window (-120d) row that
	// must NOT contribute.
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES
  ($1::uuid, $2::citext, 'checkout.complete', 9900, 'USD', $3),
  ($1::uuid, $2::citext, 'checkout.complete', 100,  'USD', $3),
  ($1::uuid, $2::citext, 'trial.start',       NULL, NULL,  $3),
  ($1::uuid, $2::citext, 'checkout.complete', 5000, 'USD', $4)`,
		tenantID, email, now.Add(-24*time.Hour), now.Add(-120*24*time.Hour)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed conversions: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversions seed: %v", err)
	}

	res, err := r.Engagement(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Engagement: %v", err)
	}
	if res.Counts.RevenueCents != 10000 {
		t.Errorf("RevenueCents = %d, want 10000 (in-window monetary only)", res.Counts.RevenueCents)
	}
	if res.Counts.RevenueCurrency != "USD" || res.Counts.MixedCurrency {
		t.Errorf("currency = %q mixed=%v, want USD/false", res.Counts.RevenueCurrency, res.Counts.MixedCurrency)
	}
	if got := res.Counts.RevenueByCurrency; len(got) != 1 || got[0] != (CurrencyRevenue{Currency: "USD", Conversions: 2, RevenueCents: 10000}) {
		t.Errorf("RevenueByCurrency = %+v, want one USD total", got)
	}
	if res.Counts.UnclassifiedMonetaryConversions != 0 {
		t.Errorf("UnclassifiedMonetaryConversions = %d, want 0", res.Counts.UnclassifiedMonetaryConversions)
	}
}

func seedEngagementRecipient(t *testing.T, pool *pgxpool.Pool, tenantID, email, status string, sentAt *time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, $2, 'engagement ledger truth', 'sent')
RETURNING id::text`, tenantID, fmt.Sprintf("engagement-ledger-%d", time.Now().UnixNano())).Scan(&campaignID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email, status, sent_at)
VALUES ($1::uuid, $2::uuid, $3::citext, $4, $5)`, tenantID, campaignID, email, status, sentAt); err != nil {
		t.Fatalf("seed recipient: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recipient: %v", err)
	}
}

// TestEngagement_UsesSendLedgerAndNeverSumsCurrencies is the adversarial
// Contact Performance contract. It proves that engagement signals cannot
// inflate sends, mixed currencies are disclosed rather than cross-summed,
// malformed denominations are count-only, and both tenant/window boundaries
// are applied to every source table.
func TestEngagement_UsesSendLedgerAndNeverSumsCurrencies(t *testing.T) {
	pool := newEngagementTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const (
		tenantID      = "00000000-0000-4000-8000-0099a2c41262"
		otherTenantID = "00000000-0000-4000-8000-0099a2c41263"
	)
	seedEngagementTenant(t, pool, tenantID)
	seedEngagementTenant(t, pool, otherTenantID)

	r := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("mixed-buyer-%d@example.test", suffix)
	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert tenant subscriber: %v", err)
	}
	if _, err := r.Upsert(ctx, otherTenantID, CreateInput{
		Email: email,
	}); err != nil {
		t.Fatalf("Upsert other-tenant subscriber: %v", err)
	}

	now := time.Now().UTC()
	recent := now.Add(-24 * time.Hour)
	old := now.Add(-91 * 24 * time.Hour)
	seedEngagementRecipient(t, pool, tenantID, email, "sent", &recent)
	seedEngagementRecipient(t, pool, tenantID, email, "sent", &old)
	seedEngagementRecipient(t, pool, tenantID, email, "failed", nil)
	seedEngagementRecipient(t, pool, otherTenantID, email, "sent", &recent)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// Five non-send engagement rows were counted as five sends by the old
	// query. A real reply is also asserted now that the final event vocabulary
	// supports it. The out-of-window open must not leak into either count.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES
  ($1::uuid, $2::citext, 'opened',       $3),
  ($1::uuid, $2::citext, 'clicked',      $3),
  ($1::uuid, $2::citext, 'replied',      $3),
  ($1::uuid, $2::citext, 'bounced',      $3),
  ($1::uuid, $2::citext, 'complained',   $3),
  ($1::uuid, $2::citext, 'unsubscribed', $3),
  ($1::uuid, $2::citext, 'opened',       $4)`, tenantID, email, recent, old); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber events: %v", err)
	}
	// CAD and USD tie on both revenue and conversion count, so CAD wins the
	// documented alphabetical tie-break. Lowercase/padded USD is canonicalized.
	// EUR ties on revenue but has fewer conversions. Invalid/missing/XXX codes
	// are excluded and counted; NULL amount is non-monetary and ignored.
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES
  ($1::uuid, $2::citext, 'purchase', 5000,  'CAD',   $3),
  ($1::uuid, $2::citext, 'purchase', 5000,  'CAD',   $3),
  ($1::uuid, $2::citext, 'purchase', 6000,  ' usd ', $3),
  ($1::uuid, $2::citext, 'purchase', 4000,  'USD',   $3),
  ($1::uuid, $2::citext, 'purchase', 10000, 'EUR',   $3),
  ($1::uuid, $2::citext, 'purchase', 700,   NULL,    $3),
  ($1::uuid, $2::citext, 'purchase', 800,   'US_D',  $3),
  ($1::uuid, $2::citext, 'purchase', 900,   'XXX',   $3),
  ($1::uuid, $2::citext, 'signup',   NULL,  NULL,    $3),
  ($1::uuid, $2::citext, 'purchase', 99999, 'GBP',   $4)`, tenantID, email, recent, old); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed mixed conversions: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant fixture: %v", err)
	}

	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("other WithTenant: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
	SELECT $1::uuid, $2::citext, 'opened', $3 FROM generate_series(1, 5)`, otherTenantID, email, recent); err != nil {
		_ = otherTx.Rollback(ctx)
		t.Fatalf("seed other-tenant events: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES ($1::uuid, $2::citext, 'purchase', 777777, 'USD', $3)`, otherTenantID, email, recent); err != nil {
		_ = otherTx.Rollback(ctx)
		t.Fatalf("seed other tenant: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit other tenant: %v", err)
	}

	res, err := r.Engagement(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Engagement: %v", err)
	}
	if res.Counts.Sends != 1 || res.Counts.Opens != 1 || res.Counts.Clicks != 1 || res.Counts.Replies != 1 {
		t.Errorf("event counts = sends:%d opens:%d clicks:%d replies:%d, want 1/1/1/1",
			res.Counts.Sends, res.Counts.Opens, res.Counts.Clicks, res.Counts.Replies)
	}
	if res.Counts.RevenueCurrency != "CAD" || res.Counts.RevenueCents != 10000 || !res.Counts.MixedCurrency {
		t.Errorf("dominant revenue = %s/%d mixed=%v, want CAD/10000/true",
			res.Counts.RevenueCurrency, res.Counts.RevenueCents, res.Counts.MixedCurrency)
	}
	wantBreakdown := []CurrencyRevenue{
		{Currency: "CAD", Conversions: 2, RevenueCents: 10000},
		{Currency: "USD", Conversions: 2, RevenueCents: 10000},
		{Currency: "EUR", Conversions: 1, RevenueCents: 10000},
	}
	if len(res.Counts.RevenueByCurrency) != len(wantBreakdown) {
		t.Fatalf("RevenueByCurrency = %+v, want %+v", res.Counts.RevenueByCurrency, wantBreakdown)
	}
	for i := range wantBreakdown {
		if res.Counts.RevenueByCurrency[i] != wantBreakdown[i] {
			t.Errorf("RevenueByCurrency[%d] = %+v, want %+v", i, res.Counts.RevenueByCurrency[i], wantBreakdown[i])
		}
	}
	if res.Counts.UnclassifiedMonetaryConversions != 3 {
		t.Errorf("UnclassifiedMonetaryConversions = %d, want 3", res.Counts.UnclassifiedMonetaryConversions)
	}

	// Public conversion amounts are individually int64, but their aggregate
	// can exceed int64. The report must stay available and make saturation
	// explicit instead of overflowing the Postgres cast and returning 500.
	overflowEmail := fmt.Sprintf("overflow-buyer-%d@example.test", suffix)
	overflowSub, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: overflowEmail,
	})
	if err != nil {
		t.Fatalf("Upsert overflow subscriber: %v", err)
	}
	overflowTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("overflow WithTenant: %v", err)
	}
	if _, err := overflowTx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES
  ($1::uuid, $2::citext, 'purchase', $3::bigint, 'USD', $5),
  ($1::uuid, $2::citext, 'purchase', $3::bigint, 'USD', $5),
  ($1::uuid, $2::citext, 'refund',   $4::bigint, 'EUR', $5),
  ($1::uuid, $2::citext, 'refund',   $4::bigint, 'EUR', $5)`,
		tenantID, overflowEmail, int64(math.MaxInt64), int64(math.MinInt64), recent); err != nil {
		_ = overflowTx.Rollback(ctx)
		t.Fatalf("seed overflowing conversions: %v", err)
	}
	if err := overflowTx.Commit(ctx); err != nil {
		t.Fatalf("commit overflowing conversions: %v", err)
	}
	overflowRes, err := r.Engagement(ctx, tenantID, overflowSub.ID)
	if err != nil {
		t.Fatalf("Engagement with overflowing sums: %v", err)
	}
	if overflowRes.Counts.RevenueCents != math.MaxInt64 || !overflowRes.Counts.RevenueCentsSaturated {
		t.Errorf("dominant saturated revenue = %d/%v, want MaxInt64/true",
			overflowRes.Counts.RevenueCents, overflowRes.Counts.RevenueCentsSaturated)
	}
	if got := overflowRes.Counts.RevenueByCurrency; len(got) != 2 ||
		got[0].Currency != "USD" || got[0].RevenueCents != math.MaxInt64 || !got[0].RevenueCentsSaturated ||
		got[1].Currency != "EUR" || got[1].RevenueCents != math.MinInt64 || !got[1].RevenueCentsSaturated {
		t.Errorf("saturated breakdown = %+v, want USD MaxInt64 + EUR MinInt64 with flags", got)
	}

	invalidEmail := fmt.Sprintf("invalid-currency-buyer-%d@example.test", suffix)
	invalidSub, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: invalidEmail,
	})
	if err != nil {
		t.Fatalf("Upsert invalid-currency subscriber: %v", err)
	}
	invalidTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("invalid-currency WithTenant: %v", err)
	}
	if _, err := invalidTx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES
  ($1::uuid, $2::citext, 'purchase', 100, NULL,  $3),
  ($1::uuid, $2::citext, 'purchase', 200, '???', $3),
  ($1::uuid, $2::citext, 'signup',   NULL, NULL, $3)`, tenantID, invalidEmail, recent); err != nil {
		_ = invalidTx.Rollback(ctx)
		t.Fatalf("seed invalid-only conversions: %v", err)
	}
	if err := invalidTx.Commit(ctx); err != nil {
		t.Fatalf("commit invalid-only conversions: %v", err)
	}
	invalidRes, err := r.Engagement(ctx, tenantID, invalidSub.ID)
	if err != nil {
		t.Fatalf("Engagement invalid-only currency: %v", err)
	}
	if invalidRes.Counts.RevenueByCurrency == nil || len(invalidRes.Counts.RevenueByCurrency) != 0 ||
		invalidRes.Counts.RevenueCurrency != "" || invalidRes.Counts.RevenueCents != 0 ||
		invalidRes.Counts.RevenueCentsSaturated || invalidRes.Counts.MixedCurrency ||
		invalidRes.Counts.UnclassifiedMonetaryConversions != 2 {
		t.Errorf("invalid-only currency contract = %+v, want empty safe totals + unclassified=2", invalidRes.Counts)
	}
}
