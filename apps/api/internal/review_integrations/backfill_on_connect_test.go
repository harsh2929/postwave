// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqReviewBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged) — models a paginated source.
type seqReviewBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqReviewBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil
	}
	return s.pages[i], nil
}

type disconnectingReviewBackfiller struct {
	store  *fakeStore
	req    SyncRequest
	called bool
	cursor string
}

func (f *disconnectingReviewBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	if f.store != nil {
		f.store.integration.Status = "disconnected"
	}
	return f.req, nil
}

func TestReviewBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	seq := &seqReviewBackfiller{pages: []SyncRequest{
		{Reviews: []ReviewInput{{}, {}}, Cursor: "c1"},
		{Reviews: []ReviewInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{},
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		YotpoBackfiller: seq,
		Now:             func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "review_1", TenantID: "tenant-1", Provider: ProviderYotpo}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 + 1 reviews seen across two pages)", res.RowsTotal)
	}
	// 2 productive pages + 1 terminal empty page.
	if seq.calls != 3 || res.PagesRun != 3 {
		t.Fatalf("calls=%d pages=%d want 3/3", seq.calls, res.PagesRun)
	}
	if len(store.runs) != 2 {
		t.Fatalf("expected a recorded run per productive page, got %d", len(store.runs))
	}
}

// A provider with no configured backfiller must be a no-op: providerPull returns
// ok=false before any HTTP call, so backfillPageOnce records nothing and the drain
// stops on its first, free iteration. This is the deliberate group-agnostic guard
// (no per-provider hasProviderPuller switch needed).
func TestReviewBackfillPageOnceNoPullerIsNoop(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	integration := &Integration{ID: "review_1", TenantID: "tenant-1", Provider: ProviderYotpo}
	res, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 0 || res.NextCursor != "" {
		t.Fatalf("no-puller must yield an empty page, got %+v", res)
	}
	if len(store.runs) != 0 {
		t.Fatalf("no run should be recorded for a non-puller, got %d", len(store.runs))
	}
}

func TestReviewBackfillOnConnectStopsBeforeProviderCallAfterDisconnect(t *testing.T) {
	store := newFakeStore()
	snapshot := store.integration
	store.integration.Status = "disconnected"
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  yotpoCursorPrefix + "2",
	}}
	d := &Deps{
		Repo:            store,
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", &snapshot, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 0 || res.NextCursor != "" {
		t.Fatalf("disconnected row should stop empty, got %+v", res)
	}
	if backfiller.called || len(store.runs) != 0 {
		t.Fatalf("provider call should be skipped after disconnect: called=%v runs=%+v", backfiller.called, store.runs)
	}
}

func TestReviewBackfillOnConnectStopsBeforeSinkWritesAfterDisconnectDuringProviderCall(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = yotpoCursorPrefix + "1"
	backfiller := &disconnectingReviewBackfiller{
		store: store,
		req: SyncRequest{
			Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
			Cursor:  yotpoCursorPrefix + "2",
		},
	}
	reviews := &fakeReviewSink{}
	d := &Deps{
		Repo:            store,
		Reviews:         reviews,
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", &store.integration, yotpoCursorPrefix+"1")
	if err != nil {
		t.Fatal(err)
	}
	if !backfiller.called || backfiller.cursor != yotpoCursorPrefix+"1" {
		t.Fatalf("called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if res.Rows != 0 || len(reviews.reviews) != 0 || len(store.runs) != 0 {
		t.Fatalf("disconnect during provider call should skip sinks/runs: res=%+v reviews=%+v runs=%+v", res, reviews.reviews, store.runs)
	}
}

func TestReviewBackfillOnConnectStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}},
		Cursor:  yotpoCursorPrefix + "2",
	}}
	d := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{err: errors.New("review sink unavailable")},
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}

	_, err := d.backfillPageOnce(context.Background(), "tenant-1", &store.integration, cursor)
	if err == nil {
		t.Fatal("expected local sync failure")
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
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

func TestReviewSettingDisabled(t *testing.T) {
	if settingDisabled(map[string]any{}, "backfill_on_connect") {
		t.Fatal("absent setting must mean enabled")
	}
	for _, v := range []any{false, "false", "off", "no", "0", "disabled"} {
		if !settingDisabled(map[string]any{"backfill_on_connect": v}, "backfill_on_connect") {
			t.Fatalf("value %v should disable", v)
		}
	}
	if settingDisabled(map[string]any{"backfill_on_connect": true}, "backfill_on_connect") {
		t.Fatal("true must keep it enabled")
	}
}
