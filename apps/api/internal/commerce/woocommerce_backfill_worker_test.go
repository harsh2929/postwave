package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeWooCommerceBackfillStore struct {
	integration       *Integration
	targets           []WooCommerceBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	lastSyncCursor    string
	lastSyncAt        time.Time
	lastSyncErr       error
	syncErr           error
}

func (f *fakeWooCommerceBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeWooCommerceBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
	f.lastSyncRequest = in
	f.lastSyncRequests = append(f.lastSyncRequests, in)
	if f.syncErr != nil {
		return nil, f.syncErr
	}
	return &SyncSummary{
		CustomersUpserted: len(in.Customers),
		ProductsUpserted:  len(in.Products),
		OrdersUpserted:    len(in.Orders),
		EventsRecorded:    len(in.ProviderEvents),
		Cursor:            in.Cursor,
	}, nil
}

func (f *fakeWooCommerceBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeWooCommerceBackfillStore) ListWooCommerceBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]WooCommerceBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceWooCommerceBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
}

func (f *sequenceWooCommerceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: woocommerceCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestWooCommerceBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 1})
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			ShopDomain: "https://store.example",
			Settings:   map[string]any{"credential_ref": "vault://commerce/woo"},
			SyncCursor: startCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceWooCommerceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "woocommerce://product/7", Title: "Beanie"}},
		Cursor:   woocommerceCursorComplete,
	}}}
	worker := &WooCommerceBackfillWorker{
		Store:          store,
		Backfiller:     backfiller,
		Limit:          7,
		DueAfter:       2 * time.Hour,
		MaxPagesPerRun: 3,
		Now:            func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Completed != 1 || summary.Failed != 0 || summary.Pages != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ProductsUpserted != 1 || len(store.lastSyncRequests) != 1 {
		t.Fatalf("sync summary=%+v requests=%+v", summary, store.lastSyncRequests)
	}
	if store.listedLimit != 7 || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("list inputs limit=%d stale_before=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor || backfiller.tenantIDs[0] != "tenant-1" {
		t.Fatalf("backfill calls tenant=%+v cursors=%+v", backfiller.tenantIDs, backfiller.cursors)
	}
}

func TestWooCommerceBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 1})
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			Status:     "disconnected",
			SyncCursor: startCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceWooCommerceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "woocommerce://product/7", Title: "Beanie"}},
		Cursor:   woocommerceCursorComplete,
	}}}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 0 || summary.Pages != 0 || summary.Completed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if backfiller.calls != 0 || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("disconnected target should not call provider or sync: calls=%d requests=%+v cursor=%q", backfiller.calls, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestWooCommerceBackfillWorkerTickContinuesAfterTargetFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "customers", Page: 1})
	providerErr := errors.New("woocommerce rate limited")
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			SyncCursor: startCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: &sequenceWooCommerceBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, err := decodeWooCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != startCursor || retry.Object != "customers" || retry.Page != 1 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) || !strings.Contains(retry.LastError, providerErr.Error()) {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if !errors.Is(store.lastSyncErr, providerErr) {
		t.Fatalf("stored failure cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestWooCommerceBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "customers", Page: 1})
	providerErr := WooCommerceRateLimitError{Path: "customers", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			SyncCursor: startCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: &sequenceWooCommerceBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, err := decodeWooCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != startCursor || retry.Object != "customers" || retry.Page != 1 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("stored retry state=%+v", retry)
	}
	var rateLimitErr WooCommerceRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimitErr) {
		t.Fatalf("stored failure err=%T %v", store.lastSyncErr, store.lastSyncErr)
	}
}

func TestWooCommerceBackfillWorkerTickSkipsRetryUntilNextAttempt(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 4})
	retryCursor := encodeWooCommerceRetryCursor(wooCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "SYNC_FAILED",
		LastError:     "database timeout",
	})
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			SyncCursor: retryCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceWooCommerceBackfiller{}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 0 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.cursors) != 0 {
		t.Fatalf("unexpected backfill calls: %+v", backfiller.cursors)
	}
	if store.lastSyncCursor != "" || store.lastSyncErr != nil {
		t.Fatalf("unexpected sync state cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestWooCommerceBackfillWorkerRetriesDueCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 4})
	retryCursor := encodeWooCommerceRetryCursor(wooCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "SYNC_FAILED",
		LastError:     "database timeout",
	})
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			SyncCursor: retryCursor,
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceWooCommerceBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "woocommerce://order/4", Status: "paid"}},
		Cursor: woocommerceCursorComplete,
	}}}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 0 || summary.Pages != 1 || summary.Completed != 1 || summary.OrdersUpserted != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != baseCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
	if store.lastSyncRequest.Cursor != woocommerceCursorComplete {
		t.Fatalf("sync request = %+v", store.lastSyncRequest)
	}
}

func TestWooCommerceBackfillWorkerCountsProviderEventPages(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "subscriptions", Page: 1})
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderWooCommerce,
			SyncCursor: startCursor,
			Settings:   map[string]any{"subscriptions_enabled": true},
		},
		targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceWooCommerceBackfiller{pages: []SyncRequest{{
		ProviderEvents: []ProviderEventInput{{EventType: "subscription_updated", SourceID: "woocommerce://subscription/881"}},
		Cursor:         woocommerceCursorComplete,
	}}}
	worker := &WooCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Completed != 1 || summary.Pages != 1 || summary.EventsRecorded != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.ProviderEvents) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
}

func TestWooCommerceBackfillWorkerTickRequiresBackfiller(t *testing.T) {
	worker := &WooCommerceBackfillWorker{
		Store: &fakeWooCommerceBackfillStore{targets: []WooCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
		}}},
	}

	summary, err := worker.tick(context.Background())
	if err == nil || summary.Targets != 1 {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
}

func TestWooCommerceBulkBackfillRunnerRecordsEmptyCompletion(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	store := &fakeWooCommerceBackfillStore{
		integration: &Integration{
			ID:       "int_1",
			TenantID: "tenant-1",
			Provider: ProviderWooCommerce,
		},
	}
	runner := WooCommerceBulkBackfillRunner{
		Store:      store,
		Backfiller: &sequenceWooCommerceBackfiller{pages: []SyncRequest{{Cursor: woocommerceCursorComplete}}},
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "int_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if !summary.Complete || summary.Pages != 0 || store.lastSyncCursor != woocommerceCursorComplete || !store.lastSyncAt.Equal(now) {
		t.Fatalf("summary=%+v stored cursor=%q at=%s", summary, store.lastSyncCursor, store.lastSyncAt)
	}
}
