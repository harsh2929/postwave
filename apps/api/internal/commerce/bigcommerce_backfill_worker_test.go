package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeBigCommerceBackfillStore struct {
	integration       *Integration
	targets           []BigCommerceBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	lastSyncCursor    string
	lastSyncAt        time.Time
	lastSyncErr       error
	syncErr           error
}

func (f *fakeBigCommerceBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeBigCommerceBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
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

func (f *fakeBigCommerceBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeBigCommerceBackfillStore) ListBigCommerceBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]BigCommerceBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceBigCommerceBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
}

func (f *sequenceBigCommerceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: bigCommerceCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestBigCommerceBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "products", Page: 1})
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			ShopDomain: "abc123",
			Settings:   map[string]any{"credential_ref": "vault://commerce/bc", "store_hash": "abc123"},
			SyncCursor: startCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceBigCommerceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "bigcommerce://product/7", Title: "Beanie"}},
		Cursor:   bigCommerceCursorComplete,
	}}}
	worker := &BigCommerceBackfillWorker{
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

func TestBigCommerceBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "products", Page: 1})
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			Status:     "disconnected",
			SyncCursor: startCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceBigCommerceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "bigcommerce://product/7", Title: "Beanie"}},
		Cursor:   bigCommerceCursorComplete,
	}}}
	worker := &BigCommerceBackfillWorker{
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

func TestBigCommerceBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "customers", Page: 1})
	providerErr := BigCommerceRateLimitError{Path: "/v3/customers", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			SyncCursor: startCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &BigCommerceBackfillWorker{
		Store:      store,
		Backfiller: &sequenceBigCommerceBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, decodeErr := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != startCursor || retry.Object != "customers" || retry.Page != 1 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("stored retry state=%+v", retry)
	}
	var rateLimitErr BigCommerceRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimitErr) {
		t.Fatalf("stored failure err=%T %v", store.lastSyncErr, store.lastSyncErr)
	}
}

func TestBigCommerceBackfillWorkerSkipsRetryUntilNextAttempt(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 4})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "SYNC_FAILED",
		LastError:     "database timeout",
	})
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			SyncCursor: retryCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceBigCommerceBackfiller{}
	worker := &BigCommerceBackfillWorker{
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

func TestBigCommerceBackfillWorkerRetriesDueCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 4})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "SYNC_FAILED",
		LastError:     "database timeout",
	})
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			SyncCursor: retryCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceBigCommerceBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "bigcommerce://order/4", Status: "paid"}},
		Cursor: bigCommerceCursorComplete,
	}}}
	worker := &BigCommerceBackfillWorker{
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
	if store.lastSyncRequest.Cursor != bigCommerceCursorComplete {
		t.Fatalf("sync request = %+v", store.lastSyncRequest)
	}
}

func TestBigCommerceBackfillWorkerPreservesDueRetryAttemptsOnFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 4})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
	})
	providerErr := BigCommerceRateLimitError{Path: "/v2/orders", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited again"}
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderBigCommerce,
			SyncCursor: retryCursor,
		},
		targets: []BigCommerceBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceBigCommerceBackfiller{err: providerErr}
	worker := &BigCommerceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != baseCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
	retry, ok, decodeErr := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.Object != "orders" || retry.Page != 4 || retry.Attempts != 3 ||
		retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) ||
		store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestBigCommerceBulkBackfillRunnerRecordsEmptyCompletion(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	store := &fakeBigCommerceBackfillStore{
		integration: &Integration{
			ID:       "int_1",
			TenantID: "tenant-1",
			Provider: ProviderBigCommerce,
		},
	}
	runner := BigCommerceBulkBackfillRunner{
		Store:      store,
		Backfiller: &sequenceBigCommerceBackfiller{pages: []SyncRequest{{Cursor: bigCommerceCursorComplete}}},
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "int_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if !summary.Complete || summary.Pages != 0 || store.lastSyncCursor != bigCommerceCursorComplete || !store.lastSyncAt.Equal(now) {
		t.Fatalf("summary=%+v stored cursor=%q at=%s", summary, store.lastSyncCursor, store.lastSyncAt)
	}
}

func TestIntegrationSyncStateExposesBigCommerceRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3}),
		Attempts:      2,
		NextAttemptAt: now.Add(10 * time.Minute).Format(time.RFC3339),
		LastStatus:    "SYNC_FAILED",
		LastError:     "database timeout",
	})
	state := integrationSyncState(cursor, now)
	if state == nil || state.CursorKind != "bigcommerce_retry" || state.Object != "orders" || state.Attempts != 2 || state.RetryDue || state.RetryWaitSeconds != int64((10*time.Minute).Seconds()) {
		t.Fatalf("state = %+v", state)
	}
}
