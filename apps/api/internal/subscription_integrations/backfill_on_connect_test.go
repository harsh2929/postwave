// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqSubscriptionBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged) — models a paginated source.
type seqSubscriptionBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqSubscriptionBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil
	}
	return s.pages[i], nil
}

func TestSubscriptionBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	seq := &seqSubscriptionBackfiller{pages: []SyncRequest{
		{Subscriptions: []SubscriptionInput{{}, {}}, Cursor: "c1"},
		{Events: []LifecycleEventInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		RechargeBackfiller: seq,
		Now:                func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "subscription_1", TenantID: "tenant-1", Provider: ProviderRecharge}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 subscriptions + 1 event seen across two pages)", res.RowsTotal)
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
func TestSubscriptionBackfillPageOnceNoPullerIsNoop(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	integration := &Integration{ID: "subscription_1", TenantID: "tenant-1", Provider: ProviderRecharge}
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

func TestSubscriptionBackfillPageOncePersistsTerminalCursor(t *testing.T) {
	store := newFakeStore()
	seq := &seqSubscriptionBackfiller{pages: []SyncRequest{{Cursor: rechargeCursorComplete}}}
	d := &Deps{
		Repo:               store,
		RechargeBackfiller: seq,
		Now:                func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{
		ID:         "subscription_1",
		TenantID:   "tenant-1",
		Provider:   ProviderRecharge,
		SyncCursor: rechargeCursorPrefix + "cur_1",
	}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, rechargeCursorPrefix+"cur_1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 0 || res.NextCursor != rechargeCursorComplete {
		t.Fatalf("result=%+v", res)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != rechargeCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSubscriptionBackfillOnConnectStopsBeforeProviderCallAfterDisconnect(t *testing.T) {
	store := newFakeStore()
	seq := &seqSubscriptionBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com"}},
		Cursor:        rechargeCursorPrefix + "cur_1",
	}}}
	d := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		RechargeBackfiller: seq,
		Now:                func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "subscription_1", TenantID: "tenant-1", Provider: ProviderRecharge}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 1 || res.NextCursor != rechargeCursorPrefix+"cur_1" || seq.calls != 1 || len(store.runs) != 1 {
		t.Fatalf("first page result=%+v calls=%d runs=%+v", res, seq.calls, store.runs)
	}

	store.integration.Status = "disconnected"
	res, err = d.backfillPageOnce(context.Background(), "tenant-1", integration, rechargeCursorPrefix+"cur_1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 0 || res.NextCursor != "" {
		t.Fatalf("disconnected result=%+v", res)
	}
	if seq.calls != 1 || len(store.runs) != 1 {
		t.Fatalf("disconnected row should stop before provider/write, calls=%d runs=%+v", seq.calls, store.runs)
	}
}

func TestSubscriptionBackfillOnConnectStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.SyncCursor = rechargeCursorPrefix + "cur_1"
	seq := &seqSubscriptionBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com"}},
		Cursor:        rechargeCursorComplete,
	}}}
	d := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{err: errors.New("profile sink unavailable")},
		RechargeBackfiller: seq,
		Now:                func() time.Time { return now },
	}
	integration := &Integration{ID: "subscription_1", TenantID: "tenant-1", Provider: ProviderRecharge}

	res, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, rechargeCursorPrefix+"cur_1")
	if err == nil {
		t.Fatal("expected local sync failure")
	}
	if res.Rows != 0 || res.NextCursor != "" {
		t.Fatalf("result=%+v", res)
	}
	if seq.calls != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("calls=%d runs=%+v", seq.calls, store.runs)
	}
	retry, ok, decodeErr := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != rechargeCursorPrefix+"cur_1" || retry.LastStatus != "SYNC_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSubscriptionSettingDisabled(t *testing.T) {
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
