// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqLoyaltyBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged) — models a paginated source.
type seqLoyaltyBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqLoyaltyBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil
	}
	return s.pages[i], nil
}

type disconnectingLoyaltyBackfiller struct {
	store  *fakeStore
	req    SyncRequest
	called bool
	cursor string
}

func (f *disconnectingLoyaltyBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	if f.store != nil {
		f.store.integration.Status = "disconnected"
	}
	return f.req, nil
}

func TestLoyaltyBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	seq := &seqLoyaltyBackfiller{pages: []SyncRequest{
		{Members: []MemberInput{{}, {}}, Cursor: "c1"},
		{Events: []LoyaltyEventInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		SmileBackfiller: seq,
		Now:             func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "loyalty_1", TenantID: "tenant-1", Provider: ProviderSmile}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 members + 1 event seen across two pages)", res.RowsTotal)
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
func TestLoyaltyBackfillPageOnceNoPullerIsNoop(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	integration := &Integration{ID: "loyalty_1", TenantID: "tenant-1", Provider: ProviderSmile}
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

func TestLoyaltyBackfillOnConnectStopsBeforeProviderCallAfterDisconnect(t *testing.T) {
	store := newFakeStore()
	snapshot := store.integration
	store.integration.Status = "disconnected"
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
		Cursor:  smileCursorPrefix + "2",
	}}
	d := &Deps{
		Repo:            store,
		SmileBackfiller: backfiller,
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

func TestLoyaltyBackfillOnConnectStopsBeforeSinkWritesAfterDisconnectDuringProviderCall(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = smileCursorPrefix + "1"
	backfiller := &disconnectingLoyaltyBackfiller{
		store: store,
		req: SyncRequest{
			Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
			Cursor:  smileCursorPrefix + "2",
		},
	}
	profiles := &fakeProfileSink{}
	d := &Deps{
		Repo:            store,
		Profiles:        profiles,
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", &store.integration, smileCursorPrefix+"1")
	if err != nil {
		t.Fatal(err)
	}
	if !backfiller.called || backfiller.cursor != smileCursorPrefix+"1" {
		t.Fatalf("called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if res.Rows != 0 || len(profiles.members) != 0 || len(store.runs) != 0 {
		t.Fatalf("disconnect during provider call should skip sinks/runs: res=%+v members=%+v runs=%+v", res, profiles.members, store.runs)
	}
}

func TestLoyaltyBackfillOnConnectStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
		Cursor:  smileCursorPrefix + "2",
	}}
	d := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{err: errors.New("profile sink unavailable")},
		SmileBackfiller: backfiller,
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
	retry, ok, decodeErr := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestLoyaltySettingDisabled(t *testing.T) {
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
