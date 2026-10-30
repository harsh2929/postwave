// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"strings"
	"testing"
	"time"
)

type fakeCRMStaticWorkerStore struct {
	*fakeStore
	targets           []CRMStaticBackfillTarget
	listedProvider    string
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeCRMStaticWorkerStore) ListCRMStaticBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]CRMStaticBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type sequenceCRMStaticBackfiller struct {
	pages   []SyncRequest
	err     error
	calls   int
	cursor  string
	cursors []string
}

func (f *sequenceCRMStaticBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.cursor = cursor
	f.cursors = append(f.cursors, cursor)
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: closeCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestCRMStaticBackfillWorkerRunsPromotedProviderAndSkipsNotDueRetry(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	notDue := encodeCRMStaticRetryCursor(ProviderClose, crmStaticRetryState{
		Cursor:        closeCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	dueCursor := closeCursorPrefix + "100"
	store := &fakeCRMStaticWorkerStore{
		fakeStore: newFakeStore(),
		targets: []CRMStaticBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "crm_wait", Cursor: notDue},
			{TenantID: "tenant-1", IntegrationID: "crm_1", Cursor: dueCursor},
		},
	}
	store.integration.Provider = ProviderClose
	store.integration.SyncCursor = dueCursor
	backfiller := &sequenceCRMStaticBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "close://contact/42", Email: "buyer@example.com"}},
		Cursor:   closeCursorComplete,
	}}}
	worker := &CRMStaticBackfillWorker{
		Provider: ProviderClose,
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:          store,
		Backfiller:     backfiller,
		Limit:          1,
		MaxPagesPerRun: 1,
		Now:            func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedProvider != ProviderClose || store.listedLimit != crmStaticBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-crmStaticBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.ContactsSeen != 1 || backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("summary=%+v calls=%d cursor=%q", summary, backfiller.calls, backfiller.cursor)
	}
}

func TestCRMStaticBackfillWorkerStoresPromotedProviderRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	cursor := closeCursorPrefix + "200"
	store := &fakeCRMStaticWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []CRMStaticBackfillTarget{{TenantID: "tenant-1", IntegrationID: "crm_1", Cursor: cursor}},
	}
	store.integration.Provider = ProviderClose
	store.integration.SyncCursor = cursor
	backfiller := &sequenceCRMStaticBackfiller{err: CRMStaticRESTError{Path: "/api/v1/contact/", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &CRMStaticBackfillWorker{
		Provider:   ProviderClose,
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	if !strings.HasPrefix(store.runs[0].CursorTo, "close_retry:") {
		t.Fatalf("cursor=%q", store.runs[0].CursorTo)
	}
	retry, ok, decodeErr := decodeCRMStaticRetryCursor(ProviderClose, store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
