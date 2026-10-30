// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// fakeVerifier records what it was asked and returns scripted verdicts.
type fakeVerifier struct {
	name string

	mu        sync.Mutex
	seen      []string
	callCount int

	// verdict maps email -> Result. Addresses not present get
	// fallback.
	verdict   map[string]Result
	fallback  Result
	err       error
	credits   int
	creditErr error
}

func (f *fakeVerifier) Name() string { return f.name }

func (f *fakeVerifier) Verify(_ context.Context, email string) (Result, error) {
	f.mu.Lock()
	f.seen = append(f.seen, email)
	f.callCount++
	f.mu.Unlock()
	if f.err != nil {
		return Result{}, f.err
	}
	if r, ok := f.verdict[email]; ok {
		r.Email = email
		r.Provider = f.name
		return r, nil
	}
	r := f.fallback
	r.Email = email
	r.Provider = f.name
	return r, nil
}

func (f *fakeVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	out := make([]Result, 0, len(emails))
	for _, e := range emails {
		r, err := f.Verify(ctx, e)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (f *fakeVerifier) Credits(context.Context) (int, error) { return f.credits, f.creditErr }

func (f *fakeVerifier) asked() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.seen...)
}

// memCache is an in-memory ResultCache for the chain tests.
type memCache struct {
	mu      sync.Mutex
	entries map[string]Result
	puts    []Result
	getErr  error
	putErr  error
}

func newMemCache() *memCache { return &memCache{entries: map[string]Result{}} }

func (m *memCache) Get(_ context.Context, emails []string) (map[string]Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return nil, m.getErr
	}
	out := map[string]Result{}
	for _, e := range emails {
		if r, ok := m.entries[e]; ok {
			out[e] = r
		}
	}
	return out, nil
}

func (m *memCache) Put(_ context.Context, results []Result) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.putErr != nil {
		return m.putErr
	}
	m.puts = append(m.puts, results...)
	for _, r := range results {
		m.entries[r.Email] = r
	}
	return nil
}

func localStub(verdicts map[string]Result) *fakeVerifier {
	return &fakeVerifier{
		name:     ProviderLocal,
		verdict:  verdicts,
		fallback: Result{Status: StatusUnknown, SubStatus: SubStatusNoMailboxProbe},
	}
}

func vendorStub(verdicts map[string]Result) *fakeVerifier {
	return &fakeVerifier{
		name:     ProviderZeroBounce,
		verdict:  verdicts,
		fallback: Result{Status: StatusValid, Billable: true},
	}
}

func TestChainSkipsVendorWhenLocalIsDecisive(t *testing.T) {
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	vendor := vendorStub(nil)
	c := &Chain{Local: local, Vendor: vendor}

	got, err := c.Verify(context.Background(), "junk@mailinator.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusDoNotMail {
		t.Fatalf("Status = %q, want %q", got.Status, StatusDoNotMail)
	}
	if vendor.callCount != 0 {
		t.Fatalf("vendor called %d times for a locally-decided address", vendor.callCount)
	}
	if got.Billable {
		t.Fatal("a locally-decided address must not be billable")
	}
}

func TestChainEscalatesToVendorWhenLocalIsInconclusive(t *testing.T) {
	local := localStub(nil) // falls back to unknown
	vendor := vendorStub(map[string]Result{
		"real@example.com": {Status: StatusValid, Billable: true},
	})
	c := &Chain{Local: local, Vendor: vendor}

	got, err := c.Verify(context.Background(), "real@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusValid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusValid)
	}
	if vendor.callCount != 1 {
		t.Fatalf("vendor called %d times, want 1", vendor.callCount)
	}
	if !got.Billable {
		t.Fatal("a vendor-verified address must be billable")
	}
}

func TestChainWithoutVendorReturnsLocalResult(t *testing.T) {
	// The free tier must be usable on its own — a tenant that has
	// configured no vendor still gets syntax/DNS/disposable filtering.
	local := localStub(nil)
	c := &Chain{Local: local}

	got, err := c.Verify(context.Background(), "someone@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnknown)
	}
	if got.Billable {
		t.Fatal("local-only result must not be billable")
	}
}

func TestChainServesCacheHitWithoutCallingEitherTier(t *testing.T) {
	cache := newMemCache()
	cache.entries["known@example.com"] = Result{
		Email: "known@example.com", Status: StatusValid, Provider: ProviderZeroBounce, Billable: true,
	}
	local := localStub(nil)
	vendor := vendorStub(nil)
	c := &Chain{Local: local, Vendor: vendor, Cache: cache}

	got, err := c.Verify(context.Background(), "known@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusValid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusValid)
	}
	if !got.Cached {
		t.Fatal("Cached = false on a cache hit")
	}
	if got.Billable {
		t.Fatal("a cache hit must be re-reported as non-billable; the credit was spent once, already")
	}
	if vendor.callCount != 0 || local.callCount != 0 {
		t.Fatalf("cache hit still called local=%d vendor=%d", local.callCount, vendor.callCount)
	}
}

func TestChainWritesVendorResultsToCache(t *testing.T) {
	cache := newMemCache()
	c := &Chain{Local: localStub(nil), Vendor: vendorStub(nil), Cache: cache}

	if _, err := c.Verify(context.Background(), "new@example.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(cache.puts) != 1 {
		t.Fatalf("cache received %d writes, want 1", len(cache.puts))
	}
	if cache.puts[0].Email != "new@example.com" {
		t.Fatalf("cached %q", cache.puts[0].Email)
	}
}

func TestChainCacheReadFailureStopsOnlyVendorPendingWork(t *testing.T) {
	const rawCanary = "cache read failed for person@example.com at private-db.internal"
	cache := newMemCache()
	cache.getErr = errors.New(rawCanary)
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	vendor := vendorStub(nil)
	chain := &Chain{Local: local, Vendor: vendor, Cache: cache}
	dispatchHookCalled := false

	results, stats, err := chain.VerifyBatchWithDispatchHook(context.Background(), []string{
		"junk@mailinator.com", "person@example.com",
	}, func(context.Context, []string) error {
		dispatchHookCalled = true
		return nil
	})
	if !errors.Is(err, ErrCacheUnavailable) {
		t.Fatalf("VerifyBatchWithDispatchHook error = %v, want ErrCacheUnavailable", err)
	}
	if strings.Contains(err.Error(), rawCanary) {
		t.Fatalf("safe cache error exposed raw storage detail: %v", err)
	}
	if results != nil {
		t.Fatalf("results = %+v, want no partially successful response", results)
	}
	if stats.LocalFiltered != 1 {
		t.Fatalf("stats = %+v, want the free local verdict measured before stopping", stats)
	}
	if dispatchHookCalled || vendor.callCount != 0 {
		t.Fatalf("failed cache read crossed vendor boundary: hook=%t calls=%d",
			dispatchHookCalled, vendor.callCount)
	}
}

func TestChainCacheWriteFailureAfterVendorIsSpendAmbiguous(t *testing.T) {
	const rawCanary = "cache write SQLSTATE canary for person@example.com"
	cache := newMemCache()
	cache.putErr = errors.New(rawCanary)
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	vendor := vendorStub(nil)
	chain := &Chain{Local: local, Vendor: vendor, Cache: cache}
	var dispatched []string

	results, stats, err := chain.VerifyBatchWithDispatchHook(context.Background(), []string{
		"junk@mailinator.com", "person@example.com",
	}, func(_ context.Context, emails []string) error {
		dispatched = append([]string(nil), emails...)
		return nil
	})
	if !errors.Is(err, ErrCacheUnavailable) {
		t.Fatalf("VerifyBatchWithDispatchHook error = %v, want ErrCacheUnavailable", err)
	}
	if strings.Contains(err.Error(), rawCanary) {
		t.Fatalf("safe cache error exposed raw storage detail: %v", err)
	}
	if results != nil {
		t.Fatalf("results = %+v, want no false successful response", results)
	}
	if !reflect.DeepEqual(dispatched, []string{"person@example.com"}) {
		t.Fatalf("dispatched = %v, want only vendor-pending address", dispatched)
	}
	if stats.LocalFiltered != 1 || stats.VendorVerified != 1 || stats.CreditsSpent != 1 {
		t.Fatalf("stats = %+v, want one local result and one measured paid result", stats)
	}
}

func TestChainCacheWriteFailureForLocalTerminalFailsClosed(t *testing.T) {
	const rawCanary = "cache write SQLSTATE canary for junk@mailinator.com"
	cache := newMemCache()
	cache.putErr = errors.New(rawCanary)
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	vendor := vendorStub(nil)
	chain := &Chain{Local: local, Vendor: vendor, Cache: cache}

	results, stats, err := chain.VerifyBatch(context.Background(), []string{"junk@mailinator.com"})
	if !errors.Is(err, ErrCacheUnavailable) {
		t.Fatalf("VerifyBatch error = %v, want ErrCacheUnavailable", err)
	}
	if strings.Contains(err.Error(), rawCanary) {
		t.Fatalf("safe cache error exposed raw storage detail: %v", err)
	}
	if results != nil {
		t.Fatalf("results = %+v, want no unretained terminal fact", results)
	}
	if stats.LocalFiltered != 1 || stats.VendorVerified != 0 || stats.CreditsSpent != 0 {
		t.Fatalf("stats = %+v, want one local result and no paid dispatch", stats)
	}
	if vendor.callCount != 0 {
		t.Fatalf("vendor calls = %d, want zero for a local terminal result", vendor.callCount)
	}
}

func TestChainDoesNotCacheProviderUnavailableResults(t *testing.T) {
	// Caching a transient failure would pin a good address to
	// "unknown" for the whole cache TTL.
	cache := newMemCache()
	vendor := &fakeVerifier{
		name: ProviderZeroBounce,
		fallback: Result{
			Status: StatusUnknown, SubStatus: SubStatusProviderUnavailable,
		},
	}
	c := &Chain{Local: localStub(nil), Vendor: vendor, Cache: cache}

	if _, err := c.Verify(context.Background(), "flaky@example.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(cache.puts) != 0 {
		t.Fatalf("cached a provider_unavailable result: %+v", cache.puts)
	}
}

func TestChainDoesNotCacheLocalOnlyResults(t *testing.T) {
	// A local "unknown" carries no information worth persisting, and
	// caching it would suppress the vendor call it exists to trigger.
	cache := newMemCache()
	c := &Chain{Local: localStub(nil), Cache: cache}

	if _, err := c.Verify(context.Background(), "a@example.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	for _, p := range cache.puts {
		if p.Status == StatusUnknown {
			t.Fatalf("cached a non-informative local unknown: %+v", p)
		}
	}
}

func TestChainCachesLocallyDecidedTerminalVerdicts(t *testing.T) {
	// A disposable domain IS worth caching: it is stable, and the
	// cache lets the import preflight report it without re-running DNS.
	cache := newMemCache()
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	c := &Chain{Local: local, Vendor: vendorStub(nil), Cache: cache}

	if _, err := c.Verify(context.Background(), "junk@mailinator.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(cache.puts) != 1 {
		t.Fatalf("cache writes = %d, want 1", len(cache.puts))
	}
}

func TestChainBatchSendsOnlySurvivorsToVendor(t *testing.T) {
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
		"nope@bad":            {Status: StatusInvalid, SubStatus: SubStatusSyntaxInvalid},
		"support@example.com": {Status: StatusUnknown, SubStatus: SubStatusRoleBased, RoleAccount: true},
	})
	vendor := vendorStub(nil)
	c := &Chain{Local: local, Vendor: vendor}

	in := []string{"junk@mailinator.com", "real@example.com", "nope@bad", "other@example.com", "support@example.com"}
	got, stats, err := c.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}

	wantAsked := []string{"real@example.com", "other@example.com", "support@example.com"}
	if asked := vendor.asked(); !reflect.DeepEqual(asked, wantAsked) {
		t.Fatalf("vendor asked %v, want %v", asked, wantAsked)
	}
	if len(got) != len(in) {
		t.Fatalf("len = %d, want %d", len(got), len(in))
	}
	for i := range in {
		if got[i].Email != in[i] {
			t.Fatalf("got[%d].Email = %q, want %q (order not preserved)", i, got[i].Email, in[i])
		}
	}
	if stats.Total != 5 {
		t.Fatalf("stats.Total = %d, want 5", stats.Total)
	}
	if stats.LocalFiltered != 2 {
		t.Fatalf("stats.LocalFiltered = %d, want 2", stats.LocalFiltered)
	}
	if stats.VendorVerified != 3 {
		t.Fatalf("stats.VendorVerified = %d, want 3", stats.VendorVerified)
	}
	if stats.CreditsSpent != 3 {
		t.Fatalf("stats.CreditsSpent = %d, want 3", stats.CreditsSpent)
	}
}

func TestChainBatchCountsCacheHitsSeparatelyFromLocalFiltering(t *testing.T) {
	cache := newMemCache()
	cache.entries["cached@example.com"] = Result{
		Email: "cached@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}
	local := localStub(map[string]Result{
		"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
	})
	vendor := vendorStub(nil)
	c := &Chain{Local: local, Vendor: vendor, Cache: cache}

	in := []string{"cached@example.com", "junk@mailinator.com", "fresh@example.com"}
	_, stats, err := c.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if stats.CacheHits != 1 {
		t.Fatalf("stats.CacheHits = %d, want 1", stats.CacheHits)
	}
	if stats.LocalFiltered != 1 {
		t.Fatalf("stats.LocalFiltered = %d, want 1", stats.LocalFiltered)
	}
	if stats.VendorVerified != 1 {
		t.Fatalf("stats.VendorVerified = %d, want 1", stats.VendorVerified)
	}
	// The cached address must be filtered out before the local tier
	// runs — the two remaining addresses are the only ones it sees.
	if asked := local.asked(); !reflect.DeepEqual(asked, []string{"junk@mailinator.com", "fresh@example.com"}) {
		t.Fatalf("local asked %v; the cached address must not reach it", asked)
	}
}

func TestChainBatchDeduplicatesRepeatedAddresses(t *testing.T) {
	// Real imports contain duplicates. Paying twice for the same
	// address in one batch is pure waste.
	vendor := vendorStub(nil)
	c := &Chain{Local: localStub(nil), Vendor: vendor}

	in := []string{"dup@example.com", "other@example.com", "dup@example.com"}
	got, stats, err := c.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	if n := len(vendor.asked()); n != 2 {
		t.Fatalf("vendor asked %d times (%v), want 2 — the duplicate must be reused", n, vendor.asked())
	}
	if stats.CreditsSpent != 2 {
		t.Fatalf("stats.CreditsSpent = %d, want 2", stats.CreditsSpent)
	}
	if got[0].Status != got[2].Status {
		t.Fatal("duplicate addresses returned different verdicts")
	}
}

func TestChainBatchDeduplicatesCanonicalAddressIdentity(t *testing.T) {
	vendor := vendorStub(nil)
	c := &Chain{Local: localStub(nil), Vendor: vendor}

	got, stats, err := c.VerifyBatch(context.Background(), []string{
		" Person@Example.COM ", "person@example.com",
	})
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if asked := vendor.asked(); !reflect.DeepEqual(asked, []string{"person@example.com"}) {
		t.Fatalf("vendor asked %v, want one canonical address", asked)
	}
	if stats.Duplicates != 1 || stats.CreditsSpent != 1 {
		t.Fatalf("stats = %+v, want one canonical duplicate and one credit", stats)
	}
	if len(got) != 2 || got[0].Email != "person@example.com" || got[1].Email != "person@example.com" {
		t.Fatalf("results = %+v, want two aligned canonical results", got)
	}
}

func TestChainFailsLoudWhenVendorIsUnavailable(t *testing.T) {
	vendor := &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable}
	c := &Chain{Local: localStub(nil), Vendor: vendor}

	_, err := c.Verify(context.Background(), "a@example.com")
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("err = %v, want ErrProviderUnavailable — silent degradation hides an outage as data", err)
	}
}

func TestChainDegradesToLocalWhenExplicitlyConfigured(t *testing.T) {
	vendor := &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable}
	c := &Chain{Local: localStub(nil), Vendor: vendor, DegradeOnVendorFailure: true}

	got, err := c.Verify(context.Background(), "a@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnknown)
	}
	if got.SubStatus != SubStatusProviderUnavailable {
		t.Fatalf("SubStatus = %q, want %q — the degradation must be visible", got.SubStatus, SubStatusProviderUnavailable)
	}
	if got.Billable {
		t.Fatal("a degraded result must not be billed")
	}
}

func TestChainPropagatesCreditExhaustionEvenWhenDegrading(t *testing.T) {
	// Running out of credits is an operator-actionable billing event,
	// not a transient blip to paper over.
	vendor := &fakeVerifier{name: ProviderZeroBounce, err: ErrNoCredits}
	c := &Chain{Local: localStub(nil), Vendor: vendor, DegradeOnVendorFailure: true}

	if _, err := c.Verify(context.Background(), "a@example.com"); !errors.Is(err, ErrNoCredits) {
		t.Fatalf("err = %v, want ErrNoCredits", err)
	}
}

func TestChainPropagatesUnauthorizedEvenWhenDegrading(t *testing.T) {
	vendor := &fakeVerifier{name: ProviderZeroBounce, err: ErrUnauthorized}
	c := &Chain{Local: localStub(nil), Vendor: vendor, DegradeOnVendorFailure: true}

	if _, err := c.Verify(context.Background(), "a@example.com"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestChainTreatsShortProviderResponseAsAmbiguous(t *testing.T) {
	const addressCanary = "private-address-canary@example.com"
	vendor := &fakeVerifier{name: ProviderZeroBounce, verdict: map[string]Result{
		addressCanary: {Status: StatusValid, Billable: true},
	}}
	// A deliberately broken adapter violates the Verifier contract by dropping
	// a result after a metered dispatch.
	vendor.fallback = Result{Status: StatusValid, Billable: true}
	short := &shortBatchVerifier{Verifier: vendor}
	c := &Chain{Local: localStub(nil), Vendor: short, DegradeOnVendorFailure: true}

	_, _, err := c.VerifyBatch(context.Background(), []string{addressCanary, "b@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("err = %v, want ErrProviderPartialOutcome", err)
	}
	if strings.Contains(err.Error(), addressCanary) {
		t.Fatalf("missing-result error exposed raw address: %v", err)
	}
}

type shortBatchVerifier struct{ Verifier }

func (s *shortBatchVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	results, err := s.Verifier.VerifyBatch(ctx, emails)
	if err != nil || len(results) == 0 {
		return results, err
	}
	return results[:len(results)-1], nil
}

func TestChainRejectsOversizeBatch(t *testing.T) {
	c := &Chain{Local: localStub(nil)}
	in := make([]string, MaxBatch+1)
	for i := range in {
		in[i] = "a@example.com"
	}
	if _, _, err := c.VerifyBatch(context.Background(), in); !errors.Is(err, ErrBatchTooLarge) {
		t.Fatalf("err = %v, want ErrBatchTooLarge", err)
	}
}

func TestChainStatsReportSavingsRatio(t *testing.T) {
	s := ChainStats{Total: 100, LocalFiltered: 25, CacheHits: 15, VendorVerified: 60, CreditsSpent: 60}
	if got := s.SavedCredits(); got != 40 {
		t.Fatalf("SavedCredits() = %d, want 40", got)
	}
	if got := s.SavingsRatio(); got != 0.4 {
		t.Fatalf("SavingsRatio() = %v, want 0.4", got)
	}
}

func TestChainStatsSavingsRatioOnEmptyBatchIsZeroNotNaN(t *testing.T) {
	var s ChainStats
	if got := s.SavingsRatio(); got != 0 {
		t.Fatalf("SavingsRatio() = %v, want 0", got)
	}
}

func TestChainRequiresAtLeastOneTier(t *testing.T) {
	c := &Chain{}
	if _, err := c.Verify(context.Background(), "a@example.com"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}
