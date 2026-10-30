package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeSquareBackfillStore struct {
	integration       *Integration
	targets           []SquareBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	deletedProducts   []ProviderDeletion
	lastSyncCursor    string
	lastSyncAt        time.Time
	lastSyncErr       error
	syncErr           error
}

func (f *fakeSquareBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeSquareBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
	f.lastSyncRequest = in
	f.lastSyncRequests = append(f.lastSyncRequests, in)
	f.deletedProducts = append(f.deletedProducts, in.ProductDeletions...)
	if f.syncErr != nil {
		return nil, f.syncErr
	}
	return &SyncSummary{
		CustomersUpserted: len(in.Customers),
		ProductsUpserted:  len(in.Products),
		ProductsDeleted:   len(in.ProductDeletions),
		OrdersUpserted:    len(in.Orders),
		EventsRecorded:    len(in.ProviderEvents),
		Cursor:            in.Cursor,
	}, nil
}

func (f *fakeSquareBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeSquareBackfillStore) ListSquareBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SquareBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceSquareBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
}

func (f *sequenceSquareBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: squareCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestSquareBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments"})
	store := &fakeSquareBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderSquare,
			ShopDomain: "MERCHANT123",
			Settings:   map[string]any{"credential_ref": "vault://commerce/square", "merchant_id": "MERCHANT123"},
			SyncCursor: startCursor,
		},
		targets: []SquareBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceSquareBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", Status: "paid"}},
		Cursor: squareCursorComplete,
	}}}
	worker := &SquareBackfillWorker{
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
	if summary.OrdersUpserted != 1 || len(store.lastSyncRequests) != 1 {
		t.Fatalf("sync summary=%+v requests=%+v", summary, store.lastSyncRequests)
	}
	if store.listedLimit != squareBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("list inputs limit=%d stale_before=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor || backfiller.tenantIDs[0] != "tenant-1" {
		t.Fatalf("backfill calls tenant=%+v cursors=%+v", backfiller.tenantIDs, backfiller.cursors)
	}
}

func TestSquareBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments"})
	store := &fakeSquareBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderSquare,
			Status:     "disconnected",
			SyncCursor: startCursor,
		},
		targets: []SquareBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceSquareBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", Status: "paid"}},
		Cursor: squareCursorComplete,
	}}}
	worker := &SquareBackfillWorker{
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

func TestSquareBackfillWorkerSkipsNotDueRetryAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	notDueBase := encodeSquareBackfillCursor(squareBackfillState{Object: "customers"})
	notDueRetry := encodeSquareRetryCursor(squareRetryState{
		Cursor:        notDueBase,
		Attempts:      1,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	})
	dueCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments"})
	store := &fakeSquareBackfillStore{
		integration: &Integration{
			ID:         "int_due",
			TenantID:   "tenant-1",
			Provider:   ProviderSquare,
			SyncCursor: dueCursor,
		},
		targets: []SquareBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_not_due",
			Cursor:        notDueRetry,
		}, {
			TenantID:      "tenant-1",
			IntegrationID: "int_due",
			Cursor:        dueCursor,
		}},
	}
	backfiller := &sequenceSquareBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", Status: "paid"}},
		Cursor: squareCursorComplete,
	}}}
	worker := &SquareBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != squareBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit = %d", store.listedLimit)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != dueCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
}

func TestSquareBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "customers"})
	providerErr := SquareRateLimitError{Path: "/v2/customers/search", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakeSquareBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderSquare,
			SyncCursor: startCursor,
		},
		targets: []SquareBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &SquareBackfillWorker{
		Store:      store,
		Backfiller: &sequenceSquareBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, decodeErr := decodeSquareRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != startCursor || retry.Object != "customers" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("stored retry state=%+v", retry)
	}
	var rateLimitErr SquareRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimitErr) {
		t.Fatalf("stored failure err=%T %v", store.lastSyncErr, store.lastSyncErr)
	}
}

func TestSquareBackfillWorkerPreservesDueRetryAttemptsOnFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	retryCursor := encodeSquareRetryCursor(squareRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
	})
	providerErr := SquareRateLimitError{Path: "/v2/payments", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited again"}
	store := &fakeSquareBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderSquare,
			SyncCursor: retryCursor,
		},
		targets: []SquareBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequenceSquareBackfiller{err: providerErr}
	worker := &SquareBackfillWorker{
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
	retry, ok, decodeErr := decodeSquareRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.Object != "payments" || retry.ProviderCursor != "cursor-payments" ||
		retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) ||
		store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}
