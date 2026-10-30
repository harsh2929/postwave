package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// fakeEnrollmentStore returns canned stats so the handler tests cover
// plumbing + goal echo + rate math without Postgres.
type fakeEnrollmentStore struct {
	stats     SequenceEnrollmentStats
	err       error
	gotTenant string
	gotSeq    string
	calls     int
}

func (f *fakeEnrollmentStore) EnrollmentStats(_ context.Context, tenantID, sequenceID string) (SequenceEnrollmentStats, error) {
	f.calls++
	f.gotTenant = tenantID
	f.gotSeq = sequenceID
	return f.stats, f.err
}

func newGoalProgressHandler(t *testing.T, goal *generation.SequenceGoal, es SequenceEnrollmentStore) *Handler {
	t.Helper()
	seqs := NewMemorySequenceStore()
	if err := seqs.Save(context.Background(), generation.Sequence{
		ID:       "seq-1",
		TenantID: "tenant-1",
		Name:     "Onboarding",
		Status:   "draft",
		Goal:     goal,
		Steps: []generation.Step{
			{Type: generation.StepTypeEmail, Position: 1, Email: &generation.EmailConfig{Subject: "Hi", Body: "One"}},
		},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: seqs,
	})
	if es != nil {
		h = h.WithSequenceEnrollments(es)
	}
	return h
}

func getGoalProgressDirect(h *Handler, id, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/sequences/"+id+"/goal-progress", nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	h.goalProgress(rec, req)
	return rec
}

func TestGoalProgressRouteIsNotPublishedWhileRuntimeIsUnavailable(t *testing.T) {
	store := &fakeEnrollmentStore{}
	h := newGoalProgressHandler(t, nil, store)
	req := httptest.NewRequest(http.MethodGet, "/sequences/seq-1/goal-progress", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for unmounted capability: %s", rec.Code, rec.Body.String())
	}
	if store.calls != 0 {
		t.Fatalf("unmounted route reached enrollment store %d time(s)", store.calls)
	}
}

func TestGoalProgressRequiresTenant(t *testing.T) {
	h := newGoalProgressHandler(t, nil, &fakeEnrollmentStore{})
	rec := getGoalProgressDirect(h, "seq-1", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestGoalProgressReturnsRetryable503WithoutStore(t *testing.T) {
	h := newGoalProgressHandler(t, nil, nil)
	rec := getGoalProgressDirect(h, "seq-1", "tenant-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "30" {
		t.Fatalf("Retry-After = %q, want 30", got)
	}
}

func TestGoalProgress404UnknownSequence(t *testing.T) {
	h := newGoalProgressHandler(t, nil, &fakeEnrollmentStore{})
	rec := getGoalProgressDirect(h, "nope", "tenant-1")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

func TestGoalProgressStoreError(t *testing.T) {
	h := newGoalProgressHandler(t, nil, &fakeEnrollmentStore{err: errors.New("boom")})
	rec := getGoalProgressDirect(h, "seq-1", "tenant-1")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
}

func TestGoalProgressComputesRateAndEchoesGoal(t *testing.T) {
	fake := &fakeEnrollmentStore{stats: SequenceEnrollmentStats{
		Enrolled:        200,
		CompletedGoal:   50,
		CompletedByKind: map[string]int{"open": 50},
	}}
	h := newGoalProgressHandler(t, &generation.SequenceGoal{
		Kind:       generation.GoalKindOpen,
		ExitOnGoal: true,
	}, fake)
	rec := getGoalProgressDirect(h, "seq-1", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var got SequenceGoalProgress
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.SequenceID != "seq-1" {
		t.Errorf("sequence_id = %q", got.SequenceID)
	}
	if got.GoalKind != "open" || !got.ExitOnGoal {
		t.Errorf("goal echo wrong: kind=%q exit=%v", got.GoalKind, got.ExitOnGoal)
	}
	if got.Enrolled != 200 || got.CompletedGoal != 50 {
		t.Errorf("counts wrong: %+v", got)
	}
	if got.CompletionRate != 25 {
		t.Errorf("completion_rate = %v, want 25", got.CompletionRate)
	}
	if got.CompletedByKind["open"] != 50 {
		t.Errorf("by-kind wrong: %+v", got.CompletedByKind)
	}
	if fake.gotTenant != "tenant-1" || fake.gotSeq != "seq-1" {
		t.Errorf("store args wrong: tenant=%q seq=%q", fake.gotTenant, fake.gotSeq)
	}
}

func TestGoalProgressZeroEnrolledNoDivByZero(t *testing.T) {
	h := newGoalProgressHandler(t, nil, &fakeEnrollmentStore{stats: SequenceEnrollmentStats{}})
	rec := getGoalProgressDirect(h, "seq-1", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var got SequenceGoalProgress
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.CompletionRate != 0 {
		t.Errorf("completion_rate = %v, want 0 for empty sequence", got.CompletionRate)
	}
	if got.CompletedByKind == nil {
		t.Error("completed_by_kind must be a non-nil map on the wire")
	}
	// No goal configured → empty goal_kind, exit false.
	if got.GoalKind != "" || got.ExitOnGoal {
		t.Errorf("expected empty goal echo, got kind=%q exit=%v", got.GoalKind, got.ExitOnGoal)
	}
}
