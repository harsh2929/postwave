package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
)

// fakeActivityStore returns canned activity rows, recording the call.
type fakeActivityStore struct {
	rows      []ParticipantActivity
	err       error
	gotTenant string
	gotSeq    string
	calls     int
}

func (f *fakeActivityStore) ListActivity(_ context.Context, tenantID, sequenceID string) ([]ParticipantActivity, error) {
	f.calls++
	f.gotTenant = tenantID
	f.gotSeq = sequenceID
	return f.rows, f.err
}

// newStuckTestHandler seeds seq-1 (tenant-1, two email steps) with the
// given stuck threshold + goal, and installs the fake activity store.
func newStuckTestHandler(t *testing.T, as SequenceActivityStore, stuckAfterDays int, goal *generation.SequenceGoal) *Handler {
	t.Helper()
	h := newParticipantsTestHandler(t, nil)
	seq, err := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-1")
	if err != nil {
		t.Fatalf("get seeded sequence: %v", err)
	}
	seq.StuckAfterDays = stuckAfterDays
	seq.Goal = goal
	if err := h.gen.Sequences.Save(context.Background(), seq); err != nil {
		t.Fatalf("save sequence: %v", err)
	}
	if as != nil {
		h = h.WithSequenceActivity(as)
	}
	return h
}

func getStuck(h *Handler, target, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------------------
// Pure evaluators
// ---------------------------------------------------------------------------

func TestGoalMet(t *testing.T) {
	a := ParticipantActivity{AnyOpen: true, AnyClick: false}
	for name, tc := range map[string]struct {
		goal *generation.SequenceGoal
		want bool
	}{
		"nil goal":                  {nil, false},
		"open goal met":             {&generation.SequenceGoal{Kind: generation.GoalKindOpen}, true},
		"click goal not met":        {&generation.SequenceGoal{Kind: generation.GoalKindClick}, false},
		"conversion never in-repo":  {&generation.SequenceGoal{Kind: generation.GoalKindConversion}, false},
		"conversion ignores events": {&generation.SequenceGoal{Kind: generation.GoalKindConversion, ExitOnGoal: true}, false},
	} {
		if got := GoalMet(tc.goal, a); got != tc.want {
			t.Errorf("%s: GoalMet = %v, want %v", name, got, tc.want)
		}
	}
	if !GoalMet(&generation.SequenceGoal{Kind: generation.GoalKindClick}, ParticipantActivity{AnyClick: true}) {
		t.Error("click goal with click event should be met")
	}
}

func TestEvaluateStuck(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	daysAgo := func(d int) time.Time { return now.Add(-time.Duration(d) * 24 * time.Hour) }
	rows := []ParticipantActivity{
		{SubscriberID: "s1", Email: "idle10@x.com", CurrentStep: 1, LastEventAt: daysAgo(10), SubscriberActive: true},
		{SubscriberID: "s2", Email: "idle4@x.com", CurrentStep: 1, LastEventAt: daysAgo(4), SubscriberActive: true},
		{SubscriberID: "s3", Email: "fresh@x.com", CurrentStep: 1, LastEventAt: daysAgo(1), SubscriberActive: true},
		{SubscriberID: "s4", Email: "exited@x.com", CurrentStep: 1, LastEventAt: daysAgo(30), SubscriberActive: false},
		{SubscriberID: "s5", Email: "done@x.com", CurrentStep: 2, LastEventAt: daysAgo(30), SubscriberActive: true},
		{SubscriberID: "s6", Email: "opened@x.com", CurrentStep: 1, LastEventAt: daysAgo(30), AnyOpen: true, SubscriberActive: true},
	}

	t.Run("threshold off returns nothing", func(t *testing.T) {
		if got := EvaluateStuck(rows, 0, 2, nil, now); len(got) != 0 {
			t.Fatalf("got %d items, want 0", len(got))
		}
	})

	t.Run("no goal", func(t *testing.T) {
		got := EvaluateStuck(rows, 3, 2, nil, now)
		// s1 (10d), s2 (4d), s6 (30d, open irrelevant without goal).
		// s3 fresh, s4 inactive, s5 completed (step 2 of 2).
		if len(got) != 3 {
			t.Fatalf("got %d items, want 3: %+v", len(got), got)
		}
		// Most idle first.
		if got[0].Email != "opened@x.com" || got[0].IdleDays != 30 {
			t.Errorf("got[0] = %+v, want opened@x.com idle 30", got[0])
		}
		if got[1].Email != "idle10@x.com" || got[1].IdleDays != 10 {
			t.Errorf("got[1] = %+v, want idle10@x.com idle 10", got[1])
		}
		if got[2].Email != "idle4@x.com" || got[2].CurrentStep != 1 {
			t.Errorf("got[2] = %+v, want idle4@x.com step 1", got[2])
		}
	})

	t.Run("open goal excludes goal-met", func(t *testing.T) {
		goal := &generation.SequenceGoal{Kind: generation.GoalKindOpen, ExitOnGoal: true}
		got := EvaluateStuck(rows, 3, 2, goal, now)
		for _, item := range got {
			if item.Email == "opened@x.com" {
				t.Fatalf("goal-met participant should not be stuck: %+v", got)
			}
		}
		if len(got) != 2 {
			t.Fatalf("got %d items, want 2: %+v", len(got), got)
		}
	})

	t.Run("conversion goal excludes nothing", func(t *testing.T) {
		goal := &generation.SequenceGoal{Kind: generation.GoalKindConversion}
		if got := EvaluateStuck(rows, 3, 2, goal, now); len(got) != 3 {
			t.Fatalf("got %d items, want 3 (conversion has no in-repo event source)", len(got))
		}
	})

	t.Run("unknown email step count never completes", func(t *testing.T) {
		got := EvaluateStuck(rows, 3, 0, nil, now)
		found := false
		for _, item := range got {
			if item.Email == "done@x.com" {
				found = true
			}
		}
		if !found {
			t.Fatalf("emailStepCount=0 should not derive completion: %+v", got)
		}
	})

	t.Run("zero last event is skipped", func(t *testing.T) {
		zero := []ParticipantActivity{{Email: "noevents@x.com", SubscriberActive: true}}
		if got := EvaluateStuck(zero, 3, 2, nil, now); len(got) != 0 {
			t.Fatalf("zero LastEventAt should not be stuck: %+v", got)
		}
	})
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

func TestStuckRequiresTenant(t *testing.T) {
	h := newStuckTestHandler(t, &fakeActivityStore{}, 7, nil)
	if rec := getStuck(h, "/sequences/seq-1/stuck", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestStuckReturnsRetryable503WithoutStore(t *testing.T) {
	h := newStuckTestHandler(t, nil, 7, nil)
	if rec := getStuck(h, "/sequences/seq-1/stuck", "tenant-1"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	} else if got := rec.Header().Get("Retry-After"); got != "30" {
		t.Fatalf("Retry-After = %q, want 30", got)
	}
}

func TestStuckUnknownSequenceIs404(t *testing.T) {
	h := newStuckTestHandler(t, &fakeActivityStore{}, 7, nil)
	if rec := getStuck(h, "/sequences/nope/stuck", "tenant-1"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

func TestStuckUnconfiguredWithoutDaysIs400(t *testing.T) {
	fake := &fakeActivityStore{}
	h := newStuckTestHandler(t, fake, 0, nil)
	rec := getStuck(h, "/sequences/seq-1/stuck", "tenant-1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if fake.calls != 0 {
		t.Fatalf("store called %d times, want 0", fake.calls)
	}
}

func TestStuckRejectsBadDaysParam(t *testing.T) {
	for _, target := range []string{
		"/sequences/seq-1/stuck?days=0",
		"/sequences/seq-1/stuck?days=-1",
		"/sequences/seq-1/stuck?days=abc",
		"/sequences/seq-1/stuck?days=366",
	} {
		h := newStuckTestHandler(t, &fakeActivityStore{}, 7, nil)
		if rec := getStuck(h, target, "tenant-1"); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", target, rec.Code, rec.Body.String())
		}
	}
}

func TestStuckHappyPathShape(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeActivityStore{rows: []ParticipantActivity{
		{SubscriberID: "sub-1", Email: "a@x.com", CurrentStep: 1,
			LastEventAt: now.Add(-9 * 24 * time.Hour), SubscriberActive: true},
		{SubscriberID: "sub-2", Email: "b@x.com", CurrentStep: 1,
			LastEventAt: now.Add(-time.Hour), SubscriberActive: true},
	}}
	h := newStuckTestHandler(t, fake, 7, nil)
	rec := getStuck(h, "/sequences/seq-1/stuck", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items         []StuckParticipant `json:"items"`
		ThresholdDays int                `json:"threshold_days"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ThresholdDays != 7 {
		t.Errorf("threshold_days = %d, want 7", resp.ThresholdDays)
	}
	if len(resp.Items) != 1 || resp.Items[0].SubscriberID != "sub-1" ||
		resp.Items[0].Email != "a@x.com" || resp.Items[0].CurrentStep != 1 || resp.Items[0].IdleDays != 9 {
		t.Fatalf("items = %+v, want one sub-1 row idle 9 days", resp.Items)
	}
	if fake.gotTenant != "tenant-1" || fake.gotSeq != "seq-1" {
		t.Errorf("store called with (%q,%q)", fake.gotTenant, fake.gotSeq)
	}
}

func TestStuckDaysOverrideBeatsStoredThreshold(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeActivityStore{rows: []ParticipantActivity{
		{SubscriberID: "sub-1", Email: "a@x.com", CurrentStep: 1,
			LastEventAt: now.Add(-3 * 24 * time.Hour), SubscriberActive: true},
	}}
	h := newStuckTestHandler(t, fake, 30, nil) // stored threshold would exclude
	rec := getStuck(h, "/sequences/seq-1/stuck?days=2", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var resp stuckResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ThresholdDays != 2 || len(resp.Items) != 1 {
		t.Fatalf("resp = %+v, want threshold 2 and one item", resp)
	}
}

// ---------------------------------------------------------------------------
// Goal / stuck_after_days storage exposure (feature 2 + 3 config)
// ---------------------------------------------------------------------------

func patchSequence(h *Handler, id, body, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPatch, "/sequences/"+id, strings.NewReader(body))
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
		if seq, err := h.gen.Sequences.Get(context.Background(), tenant, id); err == nil {
			req.Header.Set("If-Match", strconv.FormatInt(seq.Version, 10))
		}
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestPatchSequenceSetsGoalAndStuckAfterDays(t *testing.T) {
	h := newParticipantsTestHandler(t, nil)
	rec := patchSequence(h, "seq-1",
		`{"goal":{"kind":"Click","exit_on_goal":true},"stuck_after_days":14}`, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Goal == nil || got.Goal.Kind != generation.GoalKindClick || !got.Goal.ExitOnGoal {
		t.Fatalf("goal = %+v, want click/exit_on_goal (kind normalised to lowercase)", got.Goal)
	}
	if got.StuckAfterDays != 14 {
		t.Fatalf("stuck_after_days = %d, want 14", got.StuckAfterDays)
	}
	// GET exposes the same config.
	saved, err := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if saved.Goal == nil || saved.Goal.Kind != generation.GoalKindClick || saved.StuckAfterDays != 14 {
		t.Fatalf("persisted = goal %+v stuck %d", saved.Goal, saved.StuckAfterDays)
	}
}

func TestPatchSequenceClearsGoalWithNull(t *testing.T) {
	h := newStuckTestHandler(t, nil, 7, &generation.SequenceGoal{Kind: generation.GoalKindOpen})
	rec := patchSequence(h, "seq-1", `{"goal":null}`, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	saved, _ := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-1")
	if saved.Goal != nil {
		t.Fatalf("goal = %+v, want nil after explicit null", saved.Goal)
	}
	if saved.StuckAfterDays != 7 {
		t.Fatalf("stuck_after_days = %d, want 7 (absent field untouched)", saved.StuckAfterDays)
	}
}

func TestPatchSequenceAbsentGoalLeavesItUnchanged(t *testing.T) {
	h := newStuckTestHandler(t, nil, 0, &generation.SequenceGoal{Kind: generation.GoalKindOpen})
	rec := patchSequence(h, "seq-1", `{"name":"Renamed"}`, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	saved, _ := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-1")
	if saved.Goal == nil || saved.Goal.Kind != generation.GoalKindOpen {
		t.Fatalf("goal = %+v, want open goal preserved", saved.Goal)
	}
}

func TestPatchSequenceRejectsInvalidGoalAndThreshold(t *testing.T) {
	for name, body := range map[string]string{
		"unknown goal kind":         `{"goal":{"kind":"purchase"}}`,
		"empty goal kind":           `{"goal":{}}`,
		"goal wrong type":           `{"goal":"click"}`,
		"negative stuck threshold":  `{"stuck_after_days":-1}`,
		"oversized stuck threshold": `{"stuck_after_days":366}`,
	} {
		h := newParticipantsTestHandler(t, nil)
		if rec := patchSequence(h, "seq-1", body, "tenant-1"); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestCreateDraftSequenceAcceptsGoalAndStuck(t *testing.T) {
	h := newParticipantsTestHandler(t, nil)
	req := httptest.NewRequest(http.MethodPost, "/sequences", strings.NewReader(`{
		"name": "Goal seq",
		"goal": {"kind": "conversion", "exit_on_goal": true},
		"stuck_after_days": 5
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Goal == nil || got.Goal.Kind != generation.GoalKindConversion || !got.Goal.ExitOnGoal {
		t.Fatalf("goal = %+v", got.Goal)
	}
	if got.StuckAfterDays != 5 {
		t.Fatalf("stuck_after_days = %d, want 5", got.StuckAfterDays)
	}
}
