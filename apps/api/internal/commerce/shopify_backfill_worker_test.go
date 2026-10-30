package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func (f *fakeStore) ListShopifyBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]ShopifyBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.shopifyTargets, nil
}

func (f *fakeStore) ListShopifyBulkOperationTargets(_ context.Context, limit int, staleBefore time.Time) ([]ShopifyBackfillTarget, error) {
	f.listedBulkLimit = limit
	f.listedBulkStaleBefore = staleBefore
	return f.shopifyBulkTargets, nil
}

func TestShopifyBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  startCursor,
		},
		shopifyTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceShopifyBackfiller{pages: []SyncRequest{{
		Customers: []CustomerInput{{SourceID: "gid://shopify/Customer/1", Email: "buyer@example.com"}},
		Cursor:    shopifyBackfillCursorComplete,
	}}}
	worker := &ShopifyBackfillWorker{
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
	if summary.CustomersUpserted != 1 || len(store.lastSyncRequests) != 1 {
		t.Fatalf("sync summary=%+v requests=%+v", summary, store.lastSyncRequests)
	}
	if store.listedLimit != 7 || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("list inputs limit=%d stale_before=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
}

func TestShopifyBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			Status:      "disconnected",
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  startCursor,
		},
		shopifyTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceShopifyBackfiller{pages: []SyncRequest{{
		Customers: []CustomerInput{{SourceID: "gid://shopify/Customer/1", Email: "buyer@example.com"}},
		Cursor:    shopifyBackfillCursorComplete,
	}}}
	worker := &ShopifyBackfillWorker{
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

func TestShopifyBackfillWorkerTickContinuesAfterTargetFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"})
	providerErr := errors.New("shopify rate limited")
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  startCursor,
		},
		shopifyTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &ShopifyBackfillWorker{
		Store:      store,
		Backfiller: &sequenceShopifyBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if !errors.Is(store.lastSyncErr, providerErr) || store.lastSyncCursor != startCursor {
		t.Fatalf("stored failure cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestShopifyBackfillWorkerTickImportsAsyncBulkTarget(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "products", OperationID: "gid://shopify/BulkOperation/500"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  cursor,
		},
		shopifyBulkTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        cursor,
		}},
	}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID:    "int_1",
		OperationID:      "gid://shopify/BulkOperation/500",
		Object:           "products",
		Status:           "COMPLETED",
		ResultURLPresent: true,
		ResultURL:        "https://storage.googleapis.com/shopify/products.jsonl",
	}}
	importer := &fakeShopifyBulkImporter{req: SyncRequest{
		Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp", PriceCents: 2500, Currency: "USD"}},
	}}
	worker := &ShopifyBackfillWorker{
		Store:        store,
		BulkOperator: operator,
		BulkImporter: importer,
		Limit:        4,
		DueAfter:     30 * time.Minute,
		Now:          func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.AsyncTargets != 1 || summary.Completed != 1 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ProductsUpserted != 1 || len(store.lastSyncRequests) != 1 {
		t.Fatalf("sync summary=%+v requests=%+v", summary, store.lastSyncRequests)
	}
	if operator.polledOperationID != "gid://shopify/BulkOperation/500" || importer.resultURL != "https://storage.googleapis.com/shopify/products.jsonl" {
		t.Fatalf("operator id=%q importer url=%q", operator.polledOperationID, importer.resultURL)
	}
	if store.lastSyncRequest.Cursor == cursor {
		t.Fatalf("cursor did not advance: %q", store.lastSyncRequest.Cursor)
	}
	if store.listedBulkLimit != 4 || !store.listedBulkStaleBefore.Equal(now.Add(-30*time.Minute)) {
		t.Fatalf("bulk list inputs limit=%d stale_before=%s", store.listedBulkLimit, store.listedBulkStaleBefore)
	}
}

func TestShopifyBackfillWorkerSkipsDisconnectedAsyncBulkTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "products", OperationID: "gid://shopify/BulkOperation/500"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			Status:      "disconnected",
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  cursor,
		},
		shopifyBulkTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        cursor,
		}},
	}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID:    "int_1",
		OperationID:      "gid://shopify/BulkOperation/500",
		Object:           "products",
		Status:           "COMPLETED",
		ResultURLPresent: true,
		ResultURL:        "https://storage.googleapis.com/shopify/products.jsonl",
	}}
	importer := &fakeShopifyBulkImporter{req: SyncRequest{
		Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp"}},
	}}
	worker := &ShopifyBackfillWorker{
		Store:        store,
		BulkOperator: operator,
		BulkImporter: importer,
		Now:          func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.AsyncTargets != 1 || summary.Failed != 0 || summary.Completed != 0 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if operator.polledOperationID != "" || importer.resultURL != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("disconnected async target should not poll/import/sync: poll=%q import=%q requests=%+v cursor=%q", operator.polledOperationID, importer.resultURL, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestShopifyBackfillWorkerTickRecordsAsyncBulkFailure(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "orders", OperationID: "gid://shopify/BulkOperation/501"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  cursor,
		},
		shopifyBulkTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        cursor,
		}},
	}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID: "int_1",
		OperationID:   "gid://shopify/BulkOperation/501",
		Object:        "orders",
		Status:        "FAILED",
		ErrorCode:     "TIMEOUT",
	}}
	worker := &ShopifyBackfillWorker{Store: store, BulkOperator: operator}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.AsyncTargets != 1 || summary.Failed != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	state, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if state.Attempts != 1 || state.NextAttemptAt == "" || !strings.Contains(state.LastError, "TIMEOUT") {
		t.Fatalf("stored retry state=%+v err=%v", state, store.lastSyncErr)
	}
	if store.lastSyncErr == nil || !strings.Contains(store.lastSyncErr.Error(), "TIMEOUT") {
		t.Fatalf("stored cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestShopifyBackfillWorkerTickSkipsAsyncBulkUntilNextAttempt(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{
		Object:        "products",
		OperationID:   "gid://shopify/BulkOperation/502",
		Attempts:      2,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "IMPORT_FAILED",
		LastError:     "temporary download failure",
	})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  cursor,
		},
		shopifyBulkTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        cursor,
		}},
	}
	operator := &fakeShopifyBulkOperator{}
	worker := &ShopifyBackfillWorker{
		Store:        store,
		BulkOperator: operator,
		Now:          func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.AsyncTargets != 1 || summary.Completed != 0 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if operator.polledOperationID != "" {
		t.Fatalf("unexpected poll id=%q", operator.polledOperationID)
	}
	if store.lastSyncCursor != "" || store.lastSyncErr != nil {
		t.Fatalf("unexpected sync state cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestShopifyBackfillWorkerTickAdvancesCompletedAsyncBulkWithoutURL(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "customers", OperationID: "gid://shopify/BulkOperation/503"})
	store := &fakeStore{
		integration: &Integration{
			ID:          "int_1",
			TenantID:    "tenant-1",
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "shpat_123",
			SyncCursor:  cursor,
		},
		shopifyBulkTargets: []ShopifyBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        cursor,
		}},
	}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID: "int_1",
		OperationID:   "gid://shopify/BulkOperation/503",
		Object:        "customers",
		Status:        "COMPLETED",
	}}
	worker := &ShopifyBackfillWorker{Store: store, BulkOperator: operator}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.AsyncTargets != 1 || summary.Completed != 1 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	state, err := decodeShopifyBackfillCursor(store.lastSyncCursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "products" {
		t.Fatalf("cursor state=%+v", state)
	}
}
