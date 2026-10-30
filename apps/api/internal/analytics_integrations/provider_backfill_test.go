// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeAnalyticsWorkerStore struct {
	*fakeStore
	targets           []AnalyticsBackfillTarget
	listedProvider    string
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeAnalyticsWorkerStore) ListAnalyticsBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]AnalyticsBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

func TestAnalyticsBackfillWorkerRunsProviderAndSkipsNotDueRetry(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	notDue := encodeAnalyticsProviderRetryCursor(ProviderPostHog, analyticsProviderRetryState{
		Cursor:        "posthog:https://example.test/wait",
		Attempts:      1,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	})
	store := &fakeAnalyticsWorkerStore{
		fakeStore: newFakeStore(),
		targets: []AnalyticsBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "analytics_wait", Cursor: notDue},
			{TenantID: "tenant-1", IntegrationID: "analytics_1", Cursor: "posthog:https://example.test/next"},
		},
	}
	store.integration.Provider = ProviderPostHog
	store.integration.Settings = map[string]any{"project_id": "project_123"}
	backfiller := &fakeAnalyticsBackfiller{req: SyncRequest{
		Profiles: []ProfileInput{{Email: "one@example.com"}},
		Cursor:   postHogCursorComplete,
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		PostHogBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}
	worker := &AnalyticsBackfillWorker{
		Provider:   ProviderPostHog,
		Deps:       deps,
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
		Limit:      1,
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if store.listedProvider != ProviderPostHog || store.listedLimit != analyticsBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-analyticsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("list provider=%q limit=%d stale=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Completed != 1 || summary.ProfilesSeen != 1 || backfiller.calls != 1 {
		t.Fatalf("summary=%+v calls=%d", summary, backfiller.calls)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "scheduled" || store.runs[0].CursorTo != postHogCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}
