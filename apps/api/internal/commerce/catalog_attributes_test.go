// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"testing"
	"time"
)

func sig(email, category, sku string, at time.Time) catalogSignal {
	return catalogSignal{Email: email, Category: category, SKU: sku, At: at}
}

func TestCategoryHistogram_CountsNonEmpty(t *testing.T) {
	base := time.Now()
	signals := []catalogSignal{
		sig("a@x.com", "shoes", "", base),
		sig("a@x.com", "shoes", "", base),
		sig("a@x.com", "hats", "", base),
		sig("a@x.com", "", "", base), // empty category ignored
	}
	hist := categoryHistogram(signals)
	if hist["shoes"] != 2 || hist["hats"] != 1 {
		t.Fatalf("histogram = %v", hist)
	}
	if _, ok := hist[""]; ok {
		t.Fatal("empty category must not be counted")
	}
}

func TestPickFavoriteCategory_HighestCountWins(t *testing.T) {
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	signals := []catalogSignal{
		sig("a", "shoes", "", base),
		sig("a", "shoes", "", base.Add(time.Hour)),
		sig("a", "hats", "", base.Add(2*time.Hour)),
	}
	fav, ok := pickFavoriteCategory(signals)
	if !ok {
		t.Fatal("expected a favorite")
	}
	if fav.Category != "shoes" || fav.Count != 2 {
		t.Fatalf("fav = %+v, want shoes/2", fav)
	}
	// Timestamp is the most recent touch in the winning category.
	if !fav.Timestamp.Equal(base.Add(time.Hour)) {
		t.Fatalf("fav.Timestamp = %v", fav.Timestamp)
	}
}

func TestPickFavoriteCategory_TieBrokenByRecency(t *testing.T) {
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	signals := []catalogSignal{
		sig("a", "shoes", "", base),
		sig("a", "hats", "", base.Add(time.Hour)), // same count, more recent
	}
	fav, ok := pickFavoriteCategory(signals)
	if !ok || fav.Category != "hats" {
		t.Fatalf("tie should go to most recent (hats); got %+v ok=%v", fav, ok)
	}
}

func TestPickFavoriteCategory_NoCategorySignals(t *testing.T) {
	signals := []catalogSignal{sig("a", "", "sku1", time.Now())}
	if _, ok := pickFavoriteCategory(signals); ok {
		t.Fatal("no category signal should yield no favorite")
	}
}

func TestLatestSKU_MostRecentWins(t *testing.T) {
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	signals := []catalogSignal{
		sig("a", "shoes", "OLD", base),
		sig("a", "shoes", "NEW", base.Add(time.Hour)),
		sig("a", "shoes", "", base.Add(2*time.Hour)), // empty SKU ignored
	}
	sku, ok := latestSKU(signals)
	if !ok || sku != "NEW" {
		t.Fatalf("latestSKU = %q ok=%v, want NEW", sku, ok)
	}
}

func TestLatestSKU_NoSKUSignals(t *testing.T) {
	signals := []catalogSignal{sig("a", "shoes", "", time.Now())}
	if _, ok := latestSKU(signals); ok {
		t.Fatal("no SKU signal should yield no SKU")
	}
}

func TestSignalFromEvent_ReadsMetadataKeys(t *testing.T) {
	at := time.Now()
	s, ok := signalFromEvent("Person@Example.com", map[string]any{
		"category": "shoes",
		"sku":      "SKU-1",
	}, at)
	if !ok {
		t.Fatal("expected a signal")
	}
	if s.Email != "person@example.com" {
		t.Fatalf("email not lowercased: %q", s.Email)
	}
	if s.Category != "shoes" || s.SKU != "SKU-1" {
		t.Fatalf("signal = %+v", s)
	}
}

func TestSignalFromEvent_FallbackKeys(t *testing.T) {
	// category falls back to collection/product_type; sku to source_id.
	s, ok := signalFromEvent("a@b.com", map[string]any{
		"collection": "winter",
		"source_id":  "SRC-9",
	}, time.Now())
	if !ok || s.Category != "winter" || s.SKU != "SRC-9" {
		t.Fatalf("fallback signal = %+v ok=%v", s, ok)
	}
}

func TestSignalFromEvent_EmptyEmailRejected(t *testing.T) {
	if _, ok := signalFromEvent("   ", map[string]any{"category": "x"}, time.Now()); ok {
		t.Fatal("empty email must yield no signal")
	}
}

func TestFirstNonEmptyString_SkipsNonStrings(t *testing.T) {
	m := map[string]any{"a": 42, "b": "", "c": "hit"}
	if got := firstNonEmptyString(m, "a", "b", "c"); got != "hit" {
		t.Fatalf("firstNonEmptyString = %q, want hit", got)
	}
	if got := firstNonEmptyString(m, "missing"); got != "" {
		t.Fatalf("missing key = %q, want empty", got)
	}
}

func TestNormalizeSince(t *testing.T) {
	if got := normalizeSince(time.Time{}); got != "-infinity" {
		t.Fatalf("zero since = %q, want -infinity", got)
	}
	ts := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	if got := normalizeSince(ts); got != ts.Format(time.RFC3339Nano) {
		t.Fatalf("since = %q", got)
	}
}

// A nil listener / empty tenant must be a no-op so the ingest paths can call
// the trigger unconditionally without panicking when the feature is off.
func TestCatalogBackfillListener_NilSafe(t *testing.T) {
	var l *CatalogBackfillListener
	l.Trigger("00000000-0000-4000-8000-000000000001", time.Time{}) // nil receiver
	l.Wait()

	// A wired listener with an empty tenant id is also a no-op (no panic).
	wired := NewSyncCatalogBackfillListener(&Repo{}, nil)
	wired.Trigger("", time.Time{})
	wired.Wait()

	// triggerCatalogBackfill on a Repo with no listener is a no-op.
	(&Repo{}).triggerCatalogBackfill("00000000-0000-4000-8000-000000000001")
}
