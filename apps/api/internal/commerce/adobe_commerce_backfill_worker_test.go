package commerce

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeAdobeCommerceBackfillStore struct {
	integration       *Integration
	targets           []AdobeCommerceBackfillTarget
	synced            []SyncRequest
	lastSyncCursor    string
	lastSyncErr       error
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeAdobeCommerceBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeAdobeCommerceBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
	f.synced = append(f.synced, in)
	return &SyncSummary{
		CustomersUpserted: len(in.Customers),
		ProductsUpserted:  len(in.Products),
		OrdersUpserted:    len(in.Orders),
		EventsRecorded:    len(in.ProviderEvents),
		Cursor:            in.Cursor,
	}, nil
}

func (f *fakeAdobeCommerceBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, _ time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeAdobeCommerceBackfillStore) ListAdobeCommerceBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]AdobeCommerceBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceAdobeCommerceBackfiller struct {
	pages []SyncRequest
	err   error
	calls int
}

func (f *sequenceAdobeCommerceBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: adobeCommerceCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestAdobeCommerceBackfillWorkerTickRunsDueTargets(t *testing.T) {
	startCursor := encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "orders", Page: 1})
	store := &fakeAdobeCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderAdobeCommerce,
			ShopDomain: "https://magento.example.com",
			SyncCursor: startCursor,
		},
		targets: []AdobeCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceAdobeCommerceBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "adobe-commerce://order/100", TotalCents: 4200, Currency: "USD"}},
		Cursor: adobeCommerceCursorComplete,
	}}}
	worker := &AdobeCommerceBackfillWorker{
		Store:          store,
		Backfiller:     backfiller,
		Limit:          5,
		MaxPagesPerRun: 2,
		Now:            func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.OrdersUpserted != 1 || summary.Completed != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(store.synced) != 1 || len(store.synced[0].Orders) != 1 {
		t.Fatalf("synced=%+v", store.synced)
	}
	if store.listedLimit != 5 || store.listedStaleBefore.IsZero() {
		t.Fatalf("listed limit=%d stale=%v", store.listedLimit, store.listedStaleBefore)
	}
}

func TestAdobeCommerceBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	startCursor := encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "orders", Page: 1})
	store := &fakeAdobeCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderAdobeCommerce,
			Status:     "disconnected",
			ShopDomain: "https://magento.example.com",
			SyncCursor: startCursor,
		},
		targets: []AdobeCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceAdobeCommerceBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "adobe-commerce://order/100", TotalCents: 4200, Currency: "USD"}},
		Cursor: adobeCommerceCursorComplete,
	}}}
	worker := &AdobeCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC) },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 0 || summary.Pages != 0 || summary.Completed != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 0 || len(store.synced) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("disconnected target should not call provider or sync: calls=%d synced=%+v cursor=%q", backfiller.calls, store.synced, store.lastSyncCursor)
	}
}

func TestAdobeCommerceBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	startCursor := encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "customers", Page: 1})
	providerErr := AdobeCommerceRateLimitError{Path: "/customers/search", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakeAdobeCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderAdobeCommerce,
			SyncCursor: startCursor,
		},
		targets: []AdobeCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &AdobeCommerceBackfillWorker{
		Store:      store,
		Backfiller: &sequenceAdobeCommerceBackfiller{err: providerErr},
		Now:        func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Failed != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	retry, ok, decodeErr := decodeAdobeCommerceRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor=%q err=%v ok=%v", store.lastSyncCursor, decodeErr, ok)
	}
	if retry.Object != "customers" || retry.Page != 1 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
	if retry.NextAttemptAt != "2026-06-18T12:00:45Z" {
		t.Fatalf("next attempt=%q", retry.NextAttemptAt)
	}
	var rateLimit AdobeCommerceRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimit) {
		t.Fatalf("lastSyncErr=%v", store.lastSyncErr)
	}
}
