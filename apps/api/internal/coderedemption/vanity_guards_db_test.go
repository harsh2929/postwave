// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

// Guards for the four vanity-path properties the code states and nothing held.
//
// Each of these was verified by deleting or short-circuiting the behaviour it
// covers and watching the rest of the package stay green — which is exactly how
// a correct behaviour rots without anybody noticing. A comment is not a guard.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The redirect itself must never be cached or revalidated.
//
// /go/{slug} IS the meter. A 302 that a shared cache (a corporate proxy, an
// ISP transparent cache, a mail client's link preflight cache) can serve to the
// next person swallows that person's arrival entirely: the request never
// reaches us, no row is written, and the campaign is credited once for two
// people. Unlike a mis-sized counter this failure is silent and permanent —
// there is no later query that can recover an arrival that never arrived.
//
// The miss response carries the same header for a related reason: a cached 404
// would keep answering after a retired path is restored.
func TestTheVanityRedirectIsNeverCached(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	router := vanityRouter(pool)

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/go/"+f.Slug, nil))
	if first.Code != http.StatusFound {
		t.Fatalf("a live vanity path returned %d, want 302; the header assertions "+
			"below would be about the miss response instead", first.Code)
	}

	// The SUCCESS response, not just the miss. Deleting this one line leaves
	// every other test in this package passing.
	cache := first.Header().Get("Cache-Control")
	if !strings.Contains(cache, "no-store") {
		t.Fatalf("the 302 carries Cache-Control %q, want no-store — a shared cache "+
			"may replay this redirect to the next visitor, whose arrival then never "+
			"reaches us and is credited to nobody", cache)
	}
	// no-store and nothing that walks it back. `max-age` or `public` alongside it
	// is a cache directive contradicting itself, and intermediaries have
	// historically resolved that in favour of storing.
	for _, forbidden := range []string{"public", "max-age", "s-maxage", "immutable"} {
		if strings.Contains(strings.ToLower(cache), forbidden) {
			t.Errorf("Cache-Control %q also says %q, which invites the storage "+
				"no-store forbids", cache, forbidden)
		}
	}
	// A validator would let a cache keep the response and merely revalidate it,
	// and a 304 answered from the cache is an arrival we never see.
	for _, validator := range []string{"ETag", "Last-Modified", "Expires"} {
		if got := first.Header().Get(validator); got != "" {
			t.Errorf("the 302 carries %s: %q, so a cache may store it and revalidate "+
				"rather than re-ask us", validator, got)
		}
	}

	// The header is load-bearing rather than decorative: a second arrival at the
	// same URL really is a second, separately counted visit, which is precisely
	// what a cached 302 would erase.
	second := httptest.NewRecorder()
	router.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/go/"+f.Slug, nil))
	if second.Code != http.StatusFound {
		t.Fatalf("the second visit returned %d, want 302", second.Code)
	}
	if first.Header().Get("Location") == second.Header().Get("Location") {
		t.Errorf("both visits redirect to %q; two arrivals shared one visit reference",
			first.Header().Get("Location"))
	}
	totals, err := (&VanityRepo{Pool: pool}).CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 2 {
		t.Fatalf("two arrivals recorded %d visits, want 2 — each request must be "+
			"counted, which is only possible if none of them can be served from a "+
			"cache", totals.Visits)
	}

	// And the miss answers no-store too. The existing miss test only asserts the
	// four misses are IDENTICAL, which four empty headers also satisfy.
	miss := httptest.NewRecorder()
	router.ServeHTTP(miss, httptest.NewRequest(http.MethodGet, "/go/no-such-path-guard", nil))
	if miss.Code != http.StatusNotFound {
		t.Fatalf("an unknown slug returned %d, want 404", miss.Code)
	}
	if got := miss.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Errorf("the miss carries Cache-Control %q, want no-store — a cached 404 "+
			"keeps answering after a retired path is restored", got)
	}
}

// Two conversion reports racing the same visit credit the campaign ONCE.
//
// The sequential case is answered by the read of `conversion_id` at the top of
// AttributeConversion, so it proves nothing about the race: short-circuiting the
// conditional UPDATE's row-count check leaves the sequential test green. Only
// two reporters that BOTH read a NULL conversion_id before either writes reach
// the guard that actually decides this.
//
// The barrier below is what makes that ordering certain rather than hoped for:
// a third transaction holds the visit row locked, so both reporters are through
// their read and parked on the UPDATE before either can win. Without it the two
// goroutines would usually serialise and the test would quietly become a second
// copy of the sequential one.
func TestTwoConcurrentConversionReportsCreditTheCampaignOnce(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	visit, err := repo.RecordVisit(ctx, f.Slug, VisitRequest{})
	if err != nil {
		t.Fatalf("RecordVisit: %v", err)
	}

	barrier, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("barrier WithTenant: %v", err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			_ = barrier.Rollback(context.Background())
		}
	}
	defer release()

	var lockedID string
	if err := barrier.QueryRow(ctx, `
SELECT id::text FROM campaign_vanity_visits
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   FOR UPDATE`, f.TenantID, visit.Reference).Scan(&lockedID); err != nil {
		t.Fatalf("lock the visit row: %v", err)
	}
	if lockedID != visit.Reference {
		t.Fatalf("locked %q, want the visit %q", lockedID, visit.Reference)
	}

	type outcome struct {
		result *VanityConversionResult
		err    error
	}
	outcomes := make(chan outcome, 2)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, err := repo.AttributeConversion(
				context.Background(), f.TenantID, visit.Reference,
				VanityConversion{AmountCents: 5000, Currency: "usd"})
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)

	// Both reporters must be parked on the conditional UPDATE before the barrier
	// lifts. If they are not, one of them answered from its own read of
	// conversion_id and the race was never exercised — so this is a failure, not
	// a reason to carry on and assert something weaker.
	if waiters, diag := waitForConversionUpdateWaiters(t, pool, 2, 20*time.Second); waiters < 2 {
		release()
		wg.Wait()
		close(outcomes)
		var got []string
		for o := range outcomes {
			got = append(got, fmt.Sprintf("(result=%v err=%v)", o.result, o.err))
		}
		t.Fatalf("only %d reporter(s) reached the conditional UPDATE before the "+
			"barrier lifted, so the two reports did not race; outcomes=%v; active "+
			"backends=%s", waiters, got, diag)
	}

	release()
	wg.Wait()
	close(outcomes)

	var successes, conflicts int
	var winner int64
	for o := range outcomes {
		switch {
		case o.err == nil:
			successes++
			if o.result == nil {
				t.Fatal("AttributeConversion returned no error and no result")
			}
			winner = o.result.ConversionID
			if o.result.AttributedVia != AttributedViaVanityPath ||
				o.result.AttributionScope != AttributionScopeCampaign {
				t.Errorf("the winning report claims %q/%q, want %q/%q",
					o.result.AttributedVia, o.result.AttributionScope,
					AttributedViaVanityPath, AttributionScopeCampaign)
			}
		case errors.Is(o.err, ErrVisitAlreadyConverted):
			conflicts++
		default:
			t.Errorf("a concurrent report failed with an unexpected error: %v", o.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("two concurrent reports produced %d success(es) and %d conflict(s), "+
			"want exactly 1 and 1 — both reporters believed they were first and the "+
			"campaign was credited twice for one visit", successes, conflicts)
	}
	if winner == 0 {
		t.Fatal("the winning report returned conversion id 0")
	}

	// The losing report must leave NOTHING behind. Its conversion insert happened
	// before the guard fired, so a guard that merely returned an error without
	// rolling back would still have doubled the revenue.
	read, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()

	var rows int
	var total int64
	if err := read.QueryRow(ctx, `
SELECT count(*), COALESCE(sum(amount_cents), 0) FROM conversions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		f.TenantID, f.CampaignID).Scan(&rows, &total); err != nil {
		t.Fatalf("count conversions: %v", err)
	}
	if rows != 1 || total != 5000 {
		t.Errorf("the campaign carries %d conversion(s) worth %d cents, want 1 worth "+
			"5000 — one visit was credited more than once", rows, total)
	}

	var linked *int64
	if err := read.QueryRow(ctx, `
SELECT conversion_id FROM campaign_vanity_visits
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		f.TenantID, visit.Reference).Scan(&linked); err != nil {
		t.Fatalf("read visit: %v", err)
	}
	if linked == nil || *linked != winner {
		t.Errorf("the visit points at conversion %v, want the winning report's %d",
			linked, winner)
	}

	totals, err := repo.CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 1 || totals.Conversions != 1 || totals.RevenueCents != 5000 {
		t.Errorf("attribution = %+v, want 1 visit / 1 conversion / 5000 cents", *totals)
	}
}

// waitForConversionUpdateWaiters blocks until `want` backends are parked on the
// conditional UPDATE in AttributeConversion, and reports what it saw.
//
// It reads pg_stat_activity, which shows query text for sessions of the SAME
// role — every connection here is postwave_app.
func waitForConversionUpdateWaiters(
	t *testing.T, pool *db.Pool, want int, timeout time.Duration,
) (int, string) {
	t.Helper()
	ctx := context.Background()
	const waiting = `
SELECT count(*) FROM pg_stat_activity
 WHERE datname = current_database()
   AND pid <> pg_backend_pid()
   AND state = 'active'
   AND wait_event_type = 'Lock'
   AND query ILIKE '%campaign_vanity_visits SET conversion_id%'`

	deadline := time.Now().Add(timeout)
	seen := 0
	for time.Now().Before(deadline) {
		var blocked int
		if err := pool.QueryRow(ctx, waiting).Scan(&blocked); err != nil {
			t.Fatalf("inspect lock waiters: %v", err)
		}
		if blocked > seen {
			seen = blocked
		}
		if blocked >= want {
			return blocked, ""
		}
		time.Sleep(10 * time.Millisecond)
	}

	var diag string
	if err := pool.QueryRow(ctx, `
SELECT COALESCE(string_agg(
           format('[state=%s wait=%s/%s query=%s]', state, wait_event_type,
                  wait_event, left(replace(query, E'\n', ' '), 90)), ' '), '(none)')
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid()`).Scan(&diag); err != nil {
		diag = "(diagnostic query failed: " + err.Error() + ")"
	}
	return seen, diag
}

// Only a GET records a visit.
//
// A vanity path is a plain navigation, so there is no second step to hide the
// write behind the way internal/polls can. That leaves the method as the only
// thing separating a person from a machine: a mail client preflighting links, a
// scanner walking a message, or a browser prefetching one all speak HEAD, and
// each would otherwise mint a visit nobody made and credit the campaign for it.
// A visit is unfalsifiable once written — there is no subscriber to reconcile it
// against — so an over-count here is permanent.
func TestOnlyAGETRecordsAVanityVisit(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	router := vanityRouter(pool)
	repo := &VanityRepo{Pool: pool}

	for _, method := range []string{
		http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodOptions,
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(method, "/go/"+f.Slug, nil))
		if rec.Code == http.StatusFound {
			t.Errorf("%s /go/{slug} returned 302; a link preflight or a prefetch is "+
				"not a visit by any person", method)
		}
		if location := rec.Header().Get("Location"); location != "" {
			t.Errorf("%s /go/{slug} returned Location %q", method, location)
		}
	}

	// The claim is about the WRITE, not about the status code: a handler could
	// answer 405 after having already recorded the row.
	totals, err := repo.CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 0 {
		t.Fatalf("non-GET traffic recorded %d visit(s), want 0 — the campaign is "+
			"credited for arrivals no human made", totals.Visits)
	}

	// Control: a GET on the very same path DOES record one, so the zero above is
	// a refusal rather than a fixture that never worked.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/go/"+f.Slug, nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("GET /go/{slug} returned %d, want 302; the assertion above would "+
			"hold for a path that is simply broken", rec.Code)
	}
	totals, err = repo.CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 1 {
		t.Fatalf("after one GET the campaign has %d visit(s), want 1", totals.Visits)
	}
}

// The vanity provenance is its own literal value, asserted as a literal.
//
// Every other assertion in this package is self-referential — `via !=
// AttributedViaVanityPath` is satisfied by whatever the constant happens to say.
// Redefining it to "code_redemption" therefore leaves almost all of them green
// while collapsing the distinction the whole feature exists to keep: that value
// means one NAMED recipient presented a string only this campaign ever issued
// them, and this one means somebody walked through a URL anyone could hold. Once
// merged, no later query can separate the two again, because the column is all
// the evidence there is.
func TestTheVanityProvenanceIsItsOwnLiteralValue(t *testing.T) {
	if AttributedViaVanityPath != "campaign_vanity_path" {
		t.Fatalf("AttributedViaVanityPath = %q, want the literal %q", AttributedViaVanityPath,
			"campaign_vanity_path")
	}
	if AttributedViaCodeRedemption != "code_redemption" {
		t.Fatalf("AttributedViaCodeRedemption = %q, want the literal %q",
			AttributedViaCodeRedemption, "code_redemption")
	}
	if AttributedViaVanityPath == AttributedViaCodeRedemption {
		t.Fatal("the two provenances are one value; a campaign-level visit and a " +
			"per-recipient redemption would be indistinguishable in every report")
	}
	if AttributionScopeCampaign != "campaign" || AttributionScopeCampaignAssignment != "campaign_assignment" {
		t.Fatalf("attribution scopes = %q/%q, want campaign/campaign_assignment",
			AttributionScopeCampaign, AttributionScopeCampaignAssignment)
	}

	// And the literal is what actually lands in the row a report reads — pinning
	// the constant alone would not catch a write that hard-codes something else.
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	visit, err := repo.RecordVisit(ctx, f.Slug, VisitRequest{})
	if err != nil {
		t.Fatalf("RecordVisit: %v", err)
	}
	conversion, err := repo.AttributeConversion(ctx, f.TenantID, visit.Reference,
		VanityConversion{AmountCents: 2500, Currency: "usd"})
	if err != nil {
		t.Fatalf("AttributeConversion: %v", err)
	}

	read, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var via string
	if err := read.QueryRow(ctx, `
SELECT attributed_via FROM conversions WHERE tenant_id = $1::uuid AND id = $2`,
		f.TenantID, conversion.ConversionID).Scan(&via); err != nil {
		t.Fatalf("read conversion: %v", err)
	}
	if via != "campaign_vanity_path" {
		t.Errorf("the stored conversion says attributed_via = %q, want the literal "+
			"%q; weak campaign-level evidence is being filed as per-recipient proof",
			via, "campaign_vanity_path")
	}
	if via == AttributedViaCodeRedemption {
		t.Error("a vanity conversion was filed under the code-redemption provenance")
	}
}
