// SPDX-License-Identifier: AGPL-3.0-only
//
// decay_test.go — pure-logic + handler-level tests for Segment Decay
// Radar (feature #5). No live DB: persistence is faked behind DecayStore
// and audit emits are intercepted with audit.SetEmitHookForTest.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---- detectAnomalyKind (pure) ----------------------------------------

func TestDetectAnomalyKind(t *testing.T) {
	const pct = DefaultCliffPctThreshold // 0.30
	const abs = DefaultCliffAbsThreshold // 50
	cases := []struct {
		name              string
		prior, now, total int
		want              string
	}{
		// Cliff boundary: 29.9% drop is NOT a cliff; 30% is. Use a large
		// base so the absolute gate (>=50) is also satisfied.
		{"just under 30pct drop", 1000, 701, 5000, AnomalyNone}, // 29.9%
		{"exactly 30pct drop", 1000, 700, 5000, AnomalySizeCliff},
		{"40pct drop", 1000, 600, 5000, AnomalySizeCliff},
		// Absolute gate: a 50% drop of a tiny segment (3->1, drop=2 < 50)
		// must NOT page.
		{"big pct tiny abs", 3, 1, 5000, AnomalyNone},
		{"abs boundary just under", 100, 51, 5000, AnomalyNone}, // drop 49 < 50
		{"abs boundary at 50 but pct ok", 100, 50, 5000, AnomalySizeCliff},
		// Zero match: collapse to nobody from a non-empty prior.
		{"zero from 500", 500, 0, 5000, AnomalyZeroMatch},
		{"zero from zero is stable", 0, 0, 5000, AnomalyNone},
		// Everyone match: now matches all, didn't before.
		{"everyone match", 100, 5000, 5000, AnomalyEveryoneMatch},
		{"already everyone stays", 5000, 5000, 5000, AnomalyNone},
		// Growth / stable.
		{"grew", 100, 200, 5000, AnomalyNone},
		{"stable", 800, 800, 5000, AnomalyNone},
		// Division-by-zero guard: prior=0 can never be a cliff.
		{"prior zero grew", 0, 100, 5000, AnomalyNone},
		// total=0 guard: empty tenant must not be flagged everyone_match.
		{"empty tenant", 0, 0, 0, AnomalyNone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectAnomalyKind(tc.prior, tc.now, tc.total, pct, abs)
			if got != tc.want {
				t.Errorf("detectAnomalyKind(%d,%d,%d) = %q, want %q",
					tc.prior, tc.now, tc.total, got, tc.want)
			}
		})
	}
}

// ---- attributionFromClauseAttrs (pure) -------------------------------

func TestAttributionFromClauseAttrs(t *testing.T) {
	t.Run("empty input -> nil", func(t *testing.T) {
		if got := attributionFromClauseAttrs(nil); got != nil {
			t.Errorf("want nil, got %v", got)
		}
		if got := attributionFromClauseAttrs([]map[int]bool{}); got != nil {
			t.Errorf("want nil, got %v", got)
		}
	})
	t.Run("all-false leavers -> nil", func(t *testing.T) {
		in := []map[int]bool{{0: false}, {1: false}}
		if got := attributionFromClauseAttrs(in); got != nil {
			t.Errorf("want nil, got %v", got)
		}
	})
	t.Run("aggregates true matches", func(t *testing.T) {
		in := []map[int]bool{
			{0: true, 1: false},
			{0: true, 1: true},
			{0: false, 1: true},
		}
		got := attributionFromClauseAttrs(in)
		if got[0] != 2 || got[1] != 2 {
			t.Errorf("want {0:2,1:2}, got %v", got)
		}
	})
}

// ---- diffMembership + buildLogEntries + topLevelClauses (pure) -------

func TestDiffMembership(t *testing.T) {
	prior := map[string]string{"a": "a@x", "b": "b@x", "c": "c@x"}
	live := map[string]string{"b": "b@x", "d": "d@x"}
	leavers, entrants := diffMembership(prior, live)
	if len(leavers) != 2 || leavers["a"] == "" || leavers["c"] == "" {
		t.Errorf("leavers = %v", leavers)
	}
	if len(entrants) != 1 || entrants["d"] == "" {
		t.Errorf("entrants = %v", entrants)
	}
}

func TestBuildLogEntries_CapsPerDirection(t *testing.T) {
	leavers := map[string]string{}
	for i := 0; i < MembershipLogCapPerDirection+500; i++ {
		leavers[string(rune('A'+i%26))+"-"+strconv.Itoa(i)] = "e@x"
	}
	entrants := map[string]string{"x": "x@x"}
	entries := buildLogEntries(leavers, entrants, nil)
	var left, entered int
	for _, e := range entries {
		switch e.Direction {
		case "left":
			left++
		case "entered":
			entered++
		}
	}
	if left != MembershipLogCapPerDirection {
		t.Errorf("left = %d, want cap %d", left, MembershipLogCapPerDirection)
	}
	if entered != 1 {
		t.Errorf("entered = %d, want 1", entered)
	}
}

func TestTopLevelClauses(t *testing.T) {
	t.Run("empty -> nil", func(t *testing.T) {
		if got := topLevelClauses(nil); got != nil {
			t.Errorf("want nil, got %v", got)
		}
	})
	t.Run("and root -> children", func(t *testing.T) {
		ast := []byte(`{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"active"},{"op":"condition","field":"email","comparator":"equals","value":"a@x"}]}`)
		got := topLevelClauses(ast)
		if len(got) != 2 {
			t.Fatalf("want 2 clauses, got %d", len(got))
		}
	})
	t.Run("single condition -> one clause", func(t *testing.T) {
		ast := []byte(`{"op":"condition","field":"status","comparator":"equals","value":"active"}`)
		got := topLevelClauses(ast)
		if len(got) != 1 {
			t.Fatalf("want 1 clause, got %d", len(got))
		}
	})
}

// ---- narrateDecay nil-provider guard ---------------------------------

func TestNarrateDecay_NilProvider(t *testing.T) {
	text, model, err := narrateDecay(context.Background(), nil, DecayEvent{}, nil)
	if err != nil || text != "" || model != "" {
		t.Errorf("nil provider: got (%q,%q,%v), want empty/nil", text, model, err)
	}
}

type fakeProvider struct{ reply string }

func (f fakeProvider) Complete(_ context.Context, _, _ string) (string, error) {
	return f.reply, nil
}

func TestNarrateDecay_WithProvider(t *testing.T) {
	ev := DecayEvent{AnomalyKind: AnomalyZeroMatch, PriorCount: 500, NewCount: 0, LeaverCount: 500}
	text, model, err := narrateDecay(context.Background(), fakeProvider{reply: "  500 active members aged out.  "}, ev, []string{"a@x", "b@x"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if text != "500 active members aged out." {
		t.Errorf("text = %q (expected trimmed)", text)
	}
	if model != "ai-narration" {
		t.Errorf("model = %q", model)
	}
}

// ---- fakeDecayStore --------------------------------------------------

type fakeDecayStore struct {
	mu          sync.Mutex
	events      map[string]DecayEvent
	inserted    []DecayEvent
	logBatches  [][]MembershipDiffEntry
	defHistory  []DefinitionHistoryEntry
	members     []MembershipDiffEntry
	memberTotal int
	dismissed   map[string]bool
	narrations  map[string][2]string
	nextID      int
	failGet     bool
}

func newFakeStore() *fakeDecayStore {
	return &fakeDecayStore{
		events:     map[string]DecayEvent{},
		dismissed:  map[string]bool{},
		narrations: map[string][2]string{},
	}
}

func (f *fakeDecayStore) InsertDecayEvent(_ context.Context, _ string, ev DecayEvent) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := "ev-" + strconv.Itoa(f.nextID)
	ev.ID = id
	f.events[id] = ev
	f.inserted = append(f.inserted, ev)
	return id, nil
}

func (f *fakeDecayStore) ListDecayEvents(_ context.Context, _, _ string, undismissedOnly bool, _ int) ([]DecayEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []DecayEvent{}
	for _, ev := range f.events {
		if undismissedOnly && f.dismissed[ev.ID] {
			continue
		}
		out = append(out, ev)
	}
	return out, nil
}

func (f *fakeDecayStore) GetDecayEvent(_ context.Context, _, eventID string) (*DecayEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failGet {
		return nil, errors.New("boom")
	}
	ev, ok := f.events[eventID]
	if !ok {
		return nil, ErrNotFound
	}
	return &ev, nil
}

func (f *fakeDecayStore) DismissDecayEvent(_ context.Context, _, eventID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.events[eventID]; !ok {
		return ErrNotFound
	}
	f.dismissed[eventID] = true
	return nil
}

func (f *fakeDecayStore) SetNarration(_ context.Context, _, eventID, narration, model string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.events[eventID]; !ok {
		return ErrNotFound
	}
	f.narrations[eventID] = [2]string{narration, model}
	return nil
}

func (f *fakeDecayStore) InsertMembershipLogBatch(_ context.Context, _, _, _ string, entries []MembershipDiffEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logBatches = append(f.logBatches, entries)
	return nil
}

func (f *fakeDecayStore) ListMembershipLog(_ context.Context, _, _, _, _ string, _, _ int) ([]MembershipDiffEntry, int, error) {
	return f.members, f.memberTotal, nil
}

func (f *fakeDecayStore) DefinitionHistory(_ context.Context, _, _ string, _ int) ([]DefinitionHistoryEntry, error) {
	return f.defHistory, nil
}

// ---- handler tests ---------------------------------------------------

func decayTenantReq(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
	return req.WithContext(ctx)
}

func mountDecayTestRouter(d *DecayDeps) *chi.Mux {
	r := chi.NewRouter()
	r.Get("/api/v1/segments/{id}/decay-events", d.ListDecayEvents)
	r.Get("/api/v1/segments/{id}/decay-events/{event_id}/members", d.DecayEventMembers)
	r.Get("/api/v1/segments/{id}/definition-history", d.DefinitionHistory)
	r.Post("/api/v1/segments/{id}/decay-events/{event_id}/dismiss", d.DismissDecayEvent)
	r.Post("/api/v1/segments/{id}/decay-events/{event_id}/narrate", d.NarrateDecayEvent)
	return r
}

func TestListDecayEventsHandler(t *testing.T) {
	store := newFakeStore()
	store.events["ev-1"] = DecayEvent{ID: "ev-1", SegmentID: "seg-1", AnomalyKind: AnomalySizeCliff}
	d := &DecayDeps{DecayStore: store}
	r := mountDecayTestRouter(d)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("GET", "/api/v1/segments/seg-1/decay-events"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []DecayEvent `json:"items"`
		Total int          `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 1 || len(resp.Items) != 1 {
		t.Errorf("got total=%d items=%d", resp.Total, len(resp.Items))
	}
}

func TestDecayEventMembersHandler_BoundedFlag(t *testing.T) {
	store := newFakeStore()
	store.events["ev-1"] = DecayEvent{ID: "ev-1", SegmentID: "seg-1", SnapshotDate: "2026-06-15"}
	store.members = []MembershipDiffEntry{{SubscriberID: "s1", Email: "a@x", Direction: "left"}}
	store.memberTotal = MembershipLogCapPerDirection // hit the cap
	d := &DecayDeps{DecayStore: store}
	r := mountDecayTestRouter(d)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("GET", "/api/v1/segments/seg-1/decay-events/ev-1/members?direction=left"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Total           int  `json:"total"`
		BoundedByLogCap bool `json:"bounded_by_log_cap"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.BoundedByLogCap {
		t.Errorf("expected bounded_by_log_cap=true at cap, got false")
	}
}

func TestDecayEventMembersHandler_NotFound(t *testing.T) {
	store := newFakeStore()
	d := &DecayDeps{DecayStore: store}
	r := mountDecayTestRouter(d)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("GET", "/api/v1/segments/seg-1/decay-events/missing/members"))
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestDismissDecayEventHandler(t *testing.T) {
	store := newFakeStore()
	store.events["ev-1"] = DecayEvent{ID: "ev-1", SegmentID: "seg-1"}
	d := &DecayDeps{DecayStore: store}
	r := mountDecayTestRouter(d)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("POST", "/api/v1/segments/seg-1/decay-events/ev-1/dismiss"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if !store.dismissed["ev-1"] {
		t.Errorf("event not dismissed in store")
	}
}

func TestNarrateHandler_AIUnavailable(t *testing.T) {
	store := newFakeStore()
	store.events["ev-1"] = DecayEvent{ID: "ev-1", SegmentID: "seg-1"}
	d := &DecayDeps{DecayStore: store, AIProvider: nil} // no provider
	r := mountDecayTestRouter(d)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("POST", "/api/v1/segments/seg-1/decay-events/ev-1/narrate"))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", w.Code)
	}
}

func TestNarrateHandler_WithProvider(t *testing.T) {
	store := newFakeStore()
	store.events["ev-1"] = DecayEvent{ID: "ev-1", SegmentID: "seg-1", SnapshotDate: "2026-06-15", AnomalyKind: AnomalyZeroMatch}
	d := &DecayDeps{DecayStore: store, AIProvider: fakeProvider{reply: "Everyone aged out of the window."}}
	r := mountDecayTestRouter(d)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("POST", "/api/v1/segments/seg-1/decay-events/ev-1/narrate"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	got := store.narrations["ev-1"]
	if got[0] != "Everyone aged out of the window." || got[1] != "ai-narration" {
		t.Errorf("narration cached = %v", got)
	}
}

func TestDefinitionHistoryHandler(t *testing.T) {
	store := newFakeStore()
	store.defHistory = []DefinitionHistoryEntry{
		{AuditID: 2, Action: "segment.update", At: "2026-06-15T10:00:00Z"},
		{AuditID: 1, Action: "segment.update", At: "2026-06-14T10:00:00Z"},
	}
	d := &DecayDeps{DecayStore: store}
	r := mountDecayTestRouter(d)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, decayTenantReq("GET", "/api/v1/segments/seg-1/definition-history"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Items []DefinitionHistoryEntry `json:"items"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Items) != 2 || resp.Items[0].AuditID != 2 {
		t.Errorf("definition history newest-first failed: %v", resp.Items)
	}
}
