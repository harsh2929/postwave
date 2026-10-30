// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqShopifyBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged), modelling Shopify's paginated order history.
type seqShopifyBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqShopifyBackfiller) BackfillPage(_ context.Context, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil // exhausted
	}
	return s.pages[i], nil
}

func TestCommerceBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := &fakeStore{integration: &Integration{ID: "cm_1", TenantID: "tenant-1", Provider: ProviderShopify}}
	seq := &seqShopifyBackfiller{pages: []SyncRequest{
		{Orders: []OrderInput{{}, {}}, Cursor: "c1"},
		{Orders: []OrderInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:              store,
		ShopifyBackfiller: seq,
		Now:               func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", "cm_1", cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 orders seen across two pages", res.RowsTotal)
	}
	// 2 productive pages + 1 terminal empty page.
	if seq.calls != 3 || res.PagesRun != 3 {
		t.Fatalf("calls=%d pages=%d want 3/3", seq.calls, res.PagesRun)
	}
	// Only productive pages are applied via Sync (the empty page short-circuits).
	if len(store.lastSyncRequests) != 2 {
		t.Fatalf("expected 2 applied pages, got %d", len(store.lastSyncRequests))
	}
}

func TestCommerceBackfillOnConnectGating(t *testing.T) {
	if !commercePullerProviders[ProviderShopify] {
		t.Fatal("shopify must be a puller")
	}
	if commercePullerProviders["klaviyo"] {
		t.Fatal("a non-commerce provider must not be a puller")
	}
	if commerceSettingDisabled(map[string]any{}, "backfill_on_connect") {
		t.Fatal("absent setting means enabled")
	}
	for _, v := range []any{false, "false", "off", "no", "0"} {
		if !commerceSettingDisabled(map[string]any{"backfill_on_connect": v}, "backfill_on_connect") {
			t.Fatalf("value %v should disable", v)
		}
	}
}

// A provider with no puller must not drive a backfill (maybeBackfillOnConnect is
// a no-op) — exercised by confirming the backfiller is never called.
func TestCommerceMaybeBackfillSkipsNonPuller(t *testing.T) {
	seq := &seqShopifyBackfiller{pages: []SyncRequest{{Orders: []OrderInput{{}}, Cursor: "c1"}}}
	d := &Deps{Repo: &fakeStore{integration: &Integration{ID: "x", TenantID: "tenant-1"}}, ShopifyBackfiller: seq,
		Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	d.maybeBackfillOnConnect(&Integration{ID: "x", TenantID: "tenant-1", Provider: "klaviyo"})
	time.Sleep(20 * time.Millisecond)
	if seq.calls != 0 {
		t.Fatalf("non-puller provider must not backfill: calls=%d", seq.calls)
	}
}
