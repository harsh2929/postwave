// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqSupportBackfiller serves a fixed list of pages then reports exhaustion
// (no payload, cursor unchanged) — models a paginated source.
type seqSupportBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqSupportBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil
	}
	return s.pages[i], nil
}

func TestSupportBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	seq := &seqSupportBackfiller{pages: []SyncRequest{
		{Tickets: []TicketInput{{}, {}}, Cursor: "c1"},
		{Events: []SupportEventInput{{}}, Cursor: "c2"},
	}}
	d := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		Events:            &fakeEventSink{},
		ZendeskBackfiller: seq,
		Now:               func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "support_1", TenantID: "tenant-1", Provider: ProviderZendesk}

	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 tickets + 1 event seen across two pages)", res.RowsTotal)
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
func TestSupportBackfillPageOnceNoPullerIsNoop(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	integration := &Integration{ID: "support_1", TenantID: "tenant-1", Provider: ProviderZendesk}
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

func TestSupportBackfillOnConnectStopsBeforeProviderCallAfterDisconnect(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{"account_domain": "acme.gorgias.com", "credentials_ref": "cred_gorgias_1"}
	seq := &seqSupportBackfiller{pages: []SyncRequest{
		{
			Tickets: []TicketInput{{SourceID: "gorgias://ticket/1", Email: "buyer@example.com", Subject: "Need help"}},
			Cursor:  gorgiasCursorPrefix + "next",
		},
		{
			Tickets: []TicketInput{{SourceID: "gorgias://ticket/2", Email: "buyer@example.com", Subject: "Should stop"}},
			Cursor:  gorgiasCursorPrefix + "later",
		},
	}}
	suite := &fakeSuiteSink{}
	d := &Deps{
		Repo:              store,
		Suite:             suite,
		GorgiasBackfiller: seq,
		Now:               func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "support_1", TenantID: "tenant-1", Provider: ProviderGorgias}

	first, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Rows != 1 || first.NextCursor != gorgiasCursorPrefix+"next" {
		t.Fatalf("first page=%+v", first)
	}
	store.integration.Status = "disconnected"
	second, err := d.backfillPageOnce(context.Background(), "tenant-1", integration, first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if second.Rows != 0 || second.NextCursor != "" {
		t.Fatalf("disconnected page should stop empty, got %+v", second)
	}
	if seq.calls != 1 {
		t.Fatalf("provider called after disconnect: %d", seq.calls)
	}
	if len(suite.tickets) != 1 || len(store.runs) != 1 {
		t.Fatalf("unexpected writes after disconnect, tickets=%+v runs=%+v", suite.tickets, store.runs)
	}
}

func TestSupportSettingDisabled(t *testing.T) {
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
