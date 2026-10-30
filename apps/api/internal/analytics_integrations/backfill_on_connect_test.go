// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

func TestConnectBackfillStopsOnPartialWritesAndRetainsInputCheckpoint(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	previous := "posthog:https://us.posthog.com/api/projects/1/persons/?offset=1"
	store.integration.SyncCursor = previous
	puller := &seqPostHogBackfiller{pages: []SyncRequest{{Profiles: []ProfileInput{{Email: "one@example.com"}}, Events: []EventInput{{Email: "one@example.com", EventName: "test"}}, Cursor: postHogCursorComplete}}}
	d := &Deps{Repo: store, Profiles: &fakeProfileSink{}, Events: &fakeEventSink{err: errors.New("local write rejected")}, PostHogBackfiller: puller}
	result, err := d.backfillPageOnce(context.Background(), "tenant-1", &store.integration, previous)
	if err == nil || result.NextCursor == postHogCursorComplete || len(store.runs) != 1 || store.runs[0].Status != "partial" {
		t.Fatal("a partial local write was allowed to complete/advance the provider page")
	}
	retry, ok, err := decodeAnalyticsProviderRetryCursor(ProviderPostHog, store.runs[0].CursorTo)
	if err != nil || !ok || retry.Cursor != previous {
		t.Fatal("failed records cannot be retried from their original provider checkpoint")
	}
}

// seqPostHogBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged).
type seqPostHogBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqPostHogBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil
	}
	return s.pages[i], nil
}

func TestAnalyticsBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	seq := &seqPostHogBackfiller{pages: []SyncRequest{
		{Profiles: []ProfileInput{{}, {}}, Cursor: "c1"},
		{Events: []EventInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		PostHogBackfiller: seq,
		Now:               func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "analytics_1", TenantID: "tenant-1", Provider: ProviderPostHog}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 profiles + 1 event seen)", res.RowsTotal)
	}
	if seq.calls != 3 || res.PagesRun != 3 {
		t.Fatalf("calls=%d pages=%d want 3/3", seq.calls, res.PagesRun)
	}
	if len(profiles.profiles) != 2 || len(events.events) != 1 {
		t.Fatalf("expected 2 profiles + 1 event imported, got %d/%d", len(profiles.profiles), len(events.events))
	}
	if len(store.runs) != 2 {
		t.Fatalf("expected a recorded run per productive page, got %d", len(store.runs))
	}
}

func TestAnalyticsBackfillOnConnectGating(t *testing.T) {
	d := &Deps{PostHogBackfiller: &seqPostHogBackfiller{}}
	if !d.hasProviderPuller(ProviderPostHog) {
		t.Fatal("posthog with a backfiller should be a puller")
	}
	if d.hasProviderPuller(ProviderSegment) {
		t.Fatal("segment (webhook-ingest only) must not be a puller")
	}
	if settingDisabled(map[string]any{}, "backfill_on_connect") {
		t.Fatal("absent setting means enabled")
	}
	for _, v := range []any{false, "false", "off", "no", "0"} {
		if !settingDisabled(map[string]any{"backfill_on_connect": v}, "backfill_on_connect") {
			t.Fatalf("value %v should disable", v)
		}
	}
}
