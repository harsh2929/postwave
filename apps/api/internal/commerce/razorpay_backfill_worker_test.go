package commerce

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeRazorpayBackfillStore struct {
	integration       *Integration
	targets           []RazorpayBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	lastSyncRequest   SyncRequest
	lastSyncRequests  []SyncRequest
	lastSyncCursor    string
	lastSyncAt        time.Time
	lastSyncErr       error
	syncErr           error
}

func (f *fakeRazorpayBackfillStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}

func (f *fakeRazorpayBackfillStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
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

func (f *fakeRazorpayBackfillStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}

func (f *fakeRazorpayBackfillStore) ListRazorpayBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]RazorpayBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceRazorpayBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
}

func (f *sequenceRazorpayBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: razorpayCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestRazorpayBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "payments"})
	store := &fakeRazorpayBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderRazorpay,
			ShopDomain: "acc_123",
			Settings:   map[string]any{"credential_ref": "vault://commerce/razorpay", "account_id": "acc_123"},
			SyncCursor: startCursor,
		},
		targets: []RazorpayBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceRazorpayBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "razorpay://payment/pay_123", Status: "paid"}},
		Cursor: razorpayCursorComplete,
	}}}
	worker := &RazorpayBackfillWorker{
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
	if store.listedLimit != 7 || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("list inputs limit=%d stale_before=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor || backfiller.tenantIDs[0] != "tenant-1" {
		t.Fatalf("backfill calls tenant=%+v cursors=%+v", backfiller.tenantIDs, backfiller.cursors)
	}
}

func TestRazorpayBackfillWorkerSkipsDisconnectedTargets(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "payments"})
	store := &fakeRazorpayBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderRazorpay,
			Status:     "disconnected",
			SyncCursor: startCursor,
		},
		targets: []RazorpayBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	backfiller := &sequenceRazorpayBackfiller{pages: []SyncRequest{{
		Orders: []OrderInput{{SourceID: "razorpay://payment/pay_123", Status: "paid"}},
		Cursor: razorpayCursorComplete,
	}}}
	worker := &RazorpayBackfillWorker{
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

func TestRazorpayBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	startCursor := encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "customers"})
	providerErr := RazorpayRateLimitError{Path: "/v1/customers", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "rate limited"}
	store := &fakeRazorpayBackfillStore{
		integration: &Integration{
			ID:         "int_1",
			TenantID:   "tenant-1",
			Provider:   ProviderRazorpay,
			SyncCursor: startCursor,
		},
		targets: []RazorpayBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "int_1",
			Cursor:        startCursor,
		}},
	}
	worker := &RazorpayBackfillWorker{
		Store:      store,
		Backfiller: &sequenceRazorpayBackfiller{err: providerErr},
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	retry, ok, decodeErr := decodeRazorpayRetryCursor(store.lastSyncCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("stored retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, decodeErr)
	}
	if retry.Cursor != startCursor || retry.Object != "customers" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("stored retry state=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("stored retry state=%+v", retry)
	}
	var rateLimitErr RazorpayRateLimitError
	if !errors.As(store.lastSyncErr, &rateLimitErr) {
		t.Fatalf("stored failure err=%T %v", store.lastSyncErr, store.lastSyncErr)
	}
}
