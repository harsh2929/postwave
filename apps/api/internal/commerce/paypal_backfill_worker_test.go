package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakePayPalBackfillStore struct {
	integration       *Integration
	targets           []PayPalBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	lastSyncCursor    string
	lastSyncAt        time.Time
	lastSyncErr       error
	syncErr           error
}

func (f *fakePayPalBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakePayPalBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
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

func (f *fakePayPalBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakePayPalBackfillStore) ListPayPalBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]PayPalBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequencePayPalBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
}

func (f *sequencePayPalBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: payPalCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestPayPalBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 1})
	store := &fakePayPalBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderPayPal,
			ShopDomain: "MERCHANT123",
			Settings:   map[string]any{"credential_ref": "vault://commerce/paypal", "merchant_id": "MERCHANT123"},
			SyncCursor: startCursor,
		},
		targets: []PayPalBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequencePayPalBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_123", Status: "paid"}},
		Cursor: payPalCursorComplete,
	}}}
	worker := &PayPalBackfillWorker{
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
	if store.listedLimit != payPalBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("list inputs limit=%d stale_before=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor || backfiller.tenantIDs[0] != "tenant-1" {
		t.Fatalf("backfill calls tenant=%+v cursors=%+v", backfiller.tenantIDs, backfiller.cursors)
	}
}

func TestPayPalBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 1})
	store := &fakePayPalBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderPayPal,
			Status:     "disconnected",
			SyncCursor: startCursor,
		},
		targets: []PayPalBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequencePayPalBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_123", Status: "paid"}},
		Cursor: payPalCursorComplete,
	}}}
	worker := &PayPalBackfillWorker{
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

func TestPayPalBackfillWorkerSkipsNotDueRetryAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	notDueBase := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 1})
	notDueRetry := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        notDueBase,
		Attempts:      1,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	})
	dueCursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-18T00:00:00Z", End: "2026-06-29T00:00:00Z", FinalEnd: "2026-06-29T00:00:00Z", Page: 1})
	store := &fakePayPalBackfillStore{
		integration: &Integration{
			ID:         "int_due",
			TenantID:   "tenant-1",
			Provider:   ProviderPayPal,
			SyncCursor: dueCursor,
		},
		targets: []PayPalBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_not_due",
			Cursor:        notDueRetry,
		}, {
			TenantID:      "tenant-1",
			IntegrationID: "int_due",
			Cursor:        dueCursor,
		}},
	}
	backfiller := &sequencePayPalBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_123", Status: "paid"}},
		Cursor: payPalCursorComplete,
	}}}
	worker := &PayPalBackfillWorker{
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != payPalBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit = %d", store.listedLimit)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != dueCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
}

func TestPayPalBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 1})
	providerErr := PayPalRateLimitError{Path: "/v1/reporting/transactions", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakePayPalBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderPayPal,
			SyncCursor: startCursor,
		},
		targets: []PayPalBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &PayPalBackfillWorker{
		Store:      store,
		Backfiller: &sequencePayPalBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, decodeErr := decodePayPalRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != startCursor || retry.Object != "transactions" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("stored retry state=%+v", retry)
	}
	var rateLimitErr PayPalRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimitErr) {
		t.Fatalf("stored failure err=%T %v", store.lastSyncErr, store.lastSyncErr)
	}
}

func TestPayPalBackfillWorkerPreservesDueRetryAttemptsOnFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	retryCursor := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
	})
	providerErr := PayPalRateLimitError{Path: "/v1/reporting/transactions", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited again"}
	store := &fakePayPalBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderPayPal,
			SyncCursor: retryCursor,
		},
		targets: []PayPalBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        retryCursor,
		}},
	}
	backfiller := &sequencePayPalBackfiller{err: providerErr}
	worker := &PayPalBackfillWorker{
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
	retry, ok, decodeErr := decodePayPalRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.Object != "transactions" || retry.Page != 2 ||
		retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) ||
		store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}
