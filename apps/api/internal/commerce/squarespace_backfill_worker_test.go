package commerce

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeSquarespaceBackfillStore struct {
	integration       *Integration
	targets           []SquarespaceBackfillTarget
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	lastSyncCursor    string
	lastSyncErr       error
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeSquarespaceBackfillStore) GetIntegration(_ context.Context, _ string, _ string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeSquarespaceBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
	f.lastSyncRequest = in
	f.lastSyncRequests = append(f.lastSyncRequests, in)
	return &SyncSummary{
		CustomersUpserted: len(in.Customers),
		ProductsUpserted:  len(in.Products),
		OrdersUpserted:    len(in.Orders),
		Cursor:            in.Cursor,
	}, nil
}

func (f *fakeSquarespaceBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, _ time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeSquarespaceBackfillStore) ListSquarespaceBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SquarespaceBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceSquarespaceBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceSquarespaceBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: squarespaceCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestSquarespaceBackfillWorkerTickRunsDueTargets(t *testing.T) {
	store := &fakeSquarespaceBackfillStore{
		integration: &Integration{
			ID:       "int_1",
			TenantID: "tenant-1",
			Provider: ProviderSquarespace,
			Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
		},
		targets: []SquarespaceBackfillTarget{{TenantID: "tenant-1", IntegrationID: "int_1"}},
	}
	backfiller := &sequenceSquarespaceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "squarespace://product/prod_123", Title: "Canvas tote", PriceCents: 2400, Currency: "USD"}},
		Cursor:   squarespaceCursorComplete,
	}}}
	worker := &SquarespaceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Completed != 1 || summary.ProductsUpserted != 1 || summary.Pages != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(store.lastSyncRequests) != 1 || store.lastSyncRequest.Cursor != squarespaceCursorComplete {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
}

func TestSquarespaceBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	store := &fakeSquarespaceBackfillStore{
		integration: &Integration{
			ID:       "int_1",
			TenantID: "tenant-1",
			Provider: ProviderSquarespace,
			Status:   "disconnected",
			Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
		},
		targets: []SquarespaceBackfillTarget{{TenantID: "tenant-1", IntegrationID: "int_1"}},
	}
	backfiller := &sequenceSquarespaceBackfiller{pages: []SyncRequest{{
		Products: []ProductInput{{SourceID: "squarespace://product/prod_123", Title: "Canvas tote", PriceCents: 2400, Currency: "USD"}},
		Cursor:   squarespaceCursorComplete,
	}}}
	worker := &SquarespaceBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC) },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 0 || summary.Pages != 0 || summary.Completed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.pages) != 1 || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("disconnected target should not call provider or sync: pages=%+v requests=%+v cursor=%q", backfiller.pages, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSquarespaceBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	store := &fakeSquarespaceBackfillStore{
		integration: &Integration{
			ID:       "int_1",
			TenantID: "tenant-1",
			Provider: ProviderSquarespace,
			Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
		},
		targets: []SquarespaceBackfillTarget{{TenantID: "tenant-1", IntegrationID: "int_1", Cursor: encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "orders"})}},
	}
	backfiller := &sequenceSquarespaceBackfiller{err: SquarespaceRateLimitError{Path: "/1.0/commerce/orders", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &SquarespaceBackfillWorker{Store: store, Backfiller: backfiller, Now: func() time.Time { return now }}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Failed != 1 || store.lastSyncCursor == "" || store.lastSyncErr == nil {
		t.Fatalf("summary=%+v cursor=%q err=%v", summary, store.lastSyncCursor, store.lastSyncErr)
	}
	retry, ok, decodeErr := decodeSquarespaceRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.lastSyncCursor)
	}
	if retry.Object != "orders" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry = %+v", retry)
	}
	var rateLimit SquarespaceRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimit) {
		t.Fatalf("stored err = %v", store.lastSyncErr)
	}
}
