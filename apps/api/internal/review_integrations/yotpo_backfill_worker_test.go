// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeYotpoWorkerStore struct {
	*fakeStore
	targets           []YotpoBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeYotpoWorkerStore) ListYotpoBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]YotpoBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type fakeReviewWorkerStore struct {
	*fakeStore
	targets           []ReviewBackfillTarget
	listedProvider    string
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeReviewWorkerStore) ListReviewBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]ReviewBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type sequenceYotpoBackfiller struct {
	pages   []SyncRequest
	err     error
	calls   int
	cursor  string
	cursors []string
	onCall  func()
}

func (f *sequenceYotpoBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.cursor = cursor
	f.cursors = append(f.cursors, cursor)
	if f.onCall != nil {
		f.onCall()
	}
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: yotpoCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestReviewBackfillWorkerRunsPromotedProviderAndSkipsNotDueRetry(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	notDue := encodeReviewProviderRetryCursor(ProviderJudgeMe, reviewProviderRetryState{
		Cursor:        judgeMeCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	dueCursor := judgeMeCursorPrefix + "1"
	store := &fakeReviewWorkerStore{
		fakeStore: newFakeStore(),
		targets: []ReviewBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "review_wait", Cursor: notDue},
			{TenantID: "tenant-1", IntegrationID: "review_1", Cursor: dueCursor},
		},
	}
	store.integration.Provider = ProviderJudgeMe
	store.integration.SyncCursor = dueCursor
	backfiller := &sequenceYotpoBackfiller{pages: []SyncRequest{{
		Reviews: []ReviewInput{{SourceID: "judge-me://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  judgeMeCursorComplete,
	}}}
	worker := &ReviewBackfillWorker{
		Provider: ProviderJudgeMe,
		Deps: &Deps{
			Repo:     store,
			Reviews:  &fakeReviewSink{},
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
	if store.listedProvider != ProviderJudgeMe || store.listedLimit != reviewBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-reviewBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.ReviewsSeen != 1 || backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("summary=%+v calls=%d cursor=%q", summary, backfiller.calls, backfiller.cursor)
	}
}

func TestReviewBackfillWorkerStoresPromotedProviderRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	cursor := judgeMeCursorPrefix + "2"
	store := &fakeReviewWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []ReviewBackfillTarget{{TenantID: "tenant-1", IntegrationID: "review_1", Cursor: cursor}},
	}
	store.integration.Provider = ProviderJudgeMe
	store.integration.SyncCursor = cursor
	backfiller := &sequenceYotpoBackfiller{err: ReviewRESTError{StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &ReviewBackfillWorker{
		Provider:   ProviderJudgeMe,
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
	if !strings.HasPrefix(store.runs[0].CursorTo, "judge_me_retry:") {
		t.Fatalf("cursor=%q", store.runs[0].CursorTo)
	}
	retry, ok, decodeErr := decodeReviewProviderRetryCursor(ProviderJudgeMe, store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestYotpoBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	store := &fakeYotpoWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []YotpoBackfillTarget{{TenantID: "tenant-1", IntegrationID: "review_1"}},
	}
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceYotpoBackfiller{pages: []SyncRequest{{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5, Title: "Great"}},
		Cursor:  yotpoCursorPrefix + "2",
	}}}
	worker := &YotpoBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Reviews:  reviews,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.ReviewsSeen != 1 || summary.ReviewsImported != 1 || summary.ProfilesUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != yotpoBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-yotpoBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(reviews.reviews) != 1 || reviews.reviews[0].ReviewerEmail != "buyer@example.com" {
		t.Fatalf("reviews=%+v", reviews.reviews)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != yotpoCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestYotpoBackfillWorkerSkipsManyNotDueRetriesAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	notDue := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        yotpoCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	targets := make([]YotpoBackfillTarget, 0, 10)
	for i := 0; i < 9; i++ {
		targets = append(targets, YotpoBackfillTarget{TenantID: "tenant-1", IntegrationID: "review_1", Cursor: notDue})
	}
	targets = append(targets, YotpoBackfillTarget{TenantID: "tenant-1", IntegrationID: "review_1", Cursor: yotpoCursorPrefix + "1"})
	store := &fakeYotpoWorkerStore{
		fakeStore: newFakeStore(),
		targets:   targets,
	}
	backfiller := &sequenceYotpoBackfiller{pages: []SyncRequest{{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  yotpoCursorPrefix + "2",
	}}}
	worker := &YotpoBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Reviews:  &fakeReviewSink{},
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != yotpoBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit=%d want over-fetched %d", store.listedLimit, yotpoBackfillWorkerMaxCandidateScan)
	}
	if summary.Targets != 1 || summary.ReviewsSeen != 1 || backfiller.calls == 0 {
		t.Fatalf("summary=%+v calls=%d", summary, backfiller.calls)
	}
	if len(backfiller.cursors) == 0 || backfiller.cursors[0] != yotpoCursorPrefix+"1" {
		t.Fatalf("cursors=%+v", backfiller.cursors)
	}
}

func TestYotpoBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "2"
	store := &fakeYotpoWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []YotpoBackfillTarget{{TenantID: "tenant-1", IntegrationID: "review_1", Cursor: cursor}},
	}
	backfiller := &sequenceYotpoBackfiller{err: ReviewRESTError{Operation: "review REST /v1/apps/app/reviews", StatusCode: 429, RetryAfter: 4 * time.Minute, Snippet: "slow down"}}
	worker := &YotpoBackfillWorker{
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
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
	retry, ok, decodeErr := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "2" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(4*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr ReviewRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestYotpoRetryCursorKeepsEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := yotpoBackfillRetryCursor("", "BACKFILL_FAILED", ReviewRESTError{StatusCode: 429, RetryAfter: time.Minute}, now)
	retry, ok, decodeErr := decodeYotpoRetryCursor(cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, cursor)
	}
	if retry.Cursor != "" || retry.ProviderCursor != "" {
		t.Fatalf("first failure should retry from the beginning, got %+v", retry)
	}
	if retry.NextAttemptAt != now.Add(time.Minute).Format(time.RFC3339) {
		t.Fatalf("next attempt=%q", retry.NextAttemptAt)
	}
}

func TestYotpoBulkBackfillRunnerSkipsDisconnectedTargets(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = yotpoCursorPrefix + "1"
	backfiller := &sequenceYotpoBackfiller{pages: []SyncRequest{{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  yotpoCursorPrefix + "2",
	}}}
	runner := YotpoBulkBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "review_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if summary.IntegrationID != "review_1" || summary.Cursor != yotpoCursorPrefix+"1" || summary.Pages != 0 || summary.Complete {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 0 || len(store.runs) != 0 {
		t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
	}
}

func TestYotpoBulkBackfillRunnerSkipsSinkWritesAfterDisconnectDuringProviderCall(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = yotpoCursorPrefix + "1"
	reviews := &fakeReviewSink{}
	backfiller := &sequenceYotpoBackfiller{
		pages: []SyncRequest{{
			Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
			Cursor:  yotpoCursorPrefix + "2",
		}},
		onCall: func() {
			store.integration.Status = "disconnected"
		},
	}
	runner := YotpoBulkBackfillRunner{
		Deps: &Deps{
			Repo:    store,
			Reviews: reviews,
		},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "review_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if backfiller.calls != 1 {
		t.Fatalf("provider calls=%d", backfiller.calls)
	}
	if summary.Pages != 0 || len(reviews.reviews) != 0 || len(store.runs) != 0 {
		t.Fatalf("disconnect during provider call should skip sinks/runs: summary=%+v reviews=%+v runs=%+v", summary, reviews.reviews, store.runs)
	}
}

func TestYotpoBulkBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	retryCursor := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &sequenceYotpoBackfiller{err: ReviewRESTError{StatusCode: 429, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	runner := YotpoBulkBackfillRunner{
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "review_1", "")
	if err == nil {
		t.Fatal("expected provider failure")
	}
	if summary.LastError == "" || summary.Cursor == "" {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 1 || backfiller.cursor != cursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestYotpoBulkBackfillRunnerStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &sequenceYotpoBackfiller{pages: []SyncRequest{{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  yotpoCursorPrefix + "2",
	}}}
	runner := YotpoBulkBackfillRunner{
		Deps: &Deps{
			Repo:    store,
			Reviews: &fakeReviewSink{err: errors.New("review sink unavailable")},
			Now:     func() time.Time { return now },
		},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "review_1", "")
	if err == nil {
		t.Fatal("expected local sync failure")
	}
	if summary.LastError == "" || summary.Cursor == yotpoCursorPrefix+"2" {
		t.Fatalf("summary=%+v", summary)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
