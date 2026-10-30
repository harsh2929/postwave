package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// fakeParticipantStore records the query it received and returns canned
// rows, so the handler tests cover param validation + plumbing without
// Postgres (the real derivation lives in storage.ParticipantStore).
type fakeParticipantStore struct {
	items     []SequenceParticipant
	total     int
	err       error
	gotTenant string
	gotSeq    string
	gotQuery  SequenceParticipantQuery
	calls     int
}

func (f *fakeParticipantStore) ListParticipants(_ context.Context, tenantID, sequenceID string, q SequenceParticipantQuery) ([]SequenceParticipant, int, error) {
	f.calls++
	f.gotTenant = tenantID
	f.gotSeq = sequenceID
	f.gotQuery = q
	return f.items, f.total, f.err
}

// newParticipantsTestHandler builds a handler with a seeded sequence
// (two email steps + one delay step) and the given participant store.
func newParticipantsTestHandler(t *testing.T, ps SequenceParticipantStore) *Handler {
	t.Helper()
	seqs := NewMemorySequenceStore()
	if err := seqs.Save(context.Background(), generation.Sequence{
		ID:       "seq-1",
		TenantID: "tenant-1",
		Name:     "Onboarding",
		Status:   "draft",
		Steps: []generation.Step{
			{Type: generation.StepTypeEmail, Position: 1, Email: &generation.EmailConfig{Subject: "Hi", Body: "One"}},
			{Type: generation.StepTypeDelay, Position: 2, Delay: &generation.DelayConfig{}},
			{Type: generation.StepTypeEmail, Position: 3, Email: &generation.EmailConfig{Subject: "Bye", Body: "Two"}},
		},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: seqs,
	})
	if ps != nil {
		h = h.WithSequenceParticipants(ps)
	}
	return h
}

func getParticipants(h *Handler, target, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestListParticipantsRequiresTenant(t *testing.T) {
	h := newParticipantsTestHandler(t, &fakeParticipantStore{})
	rec := getParticipants(h, "/sequences/seq-1/participants", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListParticipantsReturnsRetryable503WithoutStore(t *testing.T) {
	h := newParticipantsTestHandler(t, nil)
	rec := getParticipants(h, "/sequences/seq-1/participants", "tenant-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "30" {
		t.Fatalf("Retry-After = %q, want 30", got)
	}
}

func TestListParticipantsValidatesParams(t *testing.T) {
	for _, target := range []string{
		"/sequences/seq-1/participants?status=stuck",
		"/sequences/seq-1/participants?sort=email_desc",
		"/sequences/seq-1/participants?page=0",
		"/sequences/seq-1/participants?page=abc",
		"/sequences/seq-1/participants?per_page=-5",
	} {
		fake := &fakeParticipantStore{}
		h := newParticipantsTestHandler(t, fake)
		rec := getParticipants(h, target, "tenant-1")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", target, rec.Code, rec.Body.String())
		}
		if fake.calls != 0 {
			t.Errorf("%s: store called %d times, want 0", target, fake.calls)
		}
	}
}

func TestListParticipantsUnknownSequenceIs404(t *testing.T) {
	fake := &fakeParticipantStore{}
	h := newParticipantsTestHandler(t, fake)
	rec := getParticipants(h, "/sequences/nope/participants", "tenant-1")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
	if fake.calls != 0 {
		t.Fatalf("store called %d times, want 0", fake.calls)
	}
}

func TestListParticipantsOtherTenantSequenceIs404(t *testing.T) {
	h := newParticipantsTestHandler(t, &fakeParticipantStore{})
	rec := getParticipants(h, "/sequences/seq-1/participants", "tenant-2")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

func TestListParticipantsHappyPathShapeAndPlumbing(t *testing.T) {
	entered := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	last := time.Date(2026, 6, 3, 12, 30, 0, 0, time.UTC)
	fake := &fakeParticipantStore{
		items: []SequenceParticipant{{
			SubscriberID: "sub-1",
			Email:        "a@example.com",
			Status:       "active",
			CurrentStep:  1,
			EnteredAt:    entered,
			LastEventAt:  last,
		}},
		total: 41,
	}
	h := newParticipantsTestHandler(t, fake)
	rec := getParticipants(h, "/sequences/seq-1/participants?status=Active&sort=last_event_at&page=2&per_page=20", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	// Plumbing into the store.
	if fake.gotTenant != "tenant-1" || fake.gotSeq != "seq-1" {
		t.Errorf("store got tenant=%q seq=%q", fake.gotTenant, fake.gotSeq)
	}
	want := SequenceParticipantQuery{
		Status:  "active",
		Sort:    "last_event_at_desc",
		Page:    2,
		PerPage: 20,
		// Two email steps in the seeded sequence; the delay step must
		// not count toward "completed".
		EmailStepCount: 2,
	}
	if fake.gotQuery != want {
		t.Errorf("store query = %+v, want %+v", fake.gotQuery, want)
	}

	// Wire shape.
	var resp struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
		Page  int              `json:"page"`
		Per   int              `json:"per_page"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 41 || resp.Page != 2 || resp.Per != 20 || len(resp.Items) != 1 {
		t.Fatalf("envelope = %+v", resp)
	}
	item := resp.Items[0]
	for _, k := range []string{"subscriber_id", "email", "status", "current_step", "entered_at", "last_event_at"} {
		if _, ok := item[k]; !ok {
			t.Errorf("item missing key %q: %v", k, item)
		}
	}
	if item["subscriber_id"] != "sub-1" || item["email"] != "a@example.com" || item["status"] != "active" {
		t.Errorf("item values = %v", item)
	}
}

func TestListParticipantsDefaultsAndEmptyPage(t *testing.T) {
	fake := &fakeParticipantStore{items: nil, total: 0}
	h := newParticipantsTestHandler(t, fake)
	rec := getParticipants(h, "/sequences/seq-1/participants", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if fake.gotQuery.Status != "" || fake.gotQuery.Sort != "entered_at_desc" ||
		fake.gotQuery.Page != 1 || fake.gotQuery.PerPage != participantsDefaultPerPage {
		t.Errorf("default query = %+v", fake.gotQuery)
	}
	// items must serialize as [] (not null) for the desktop table.
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(rec.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(raw["items"]) != "[]" {
		t.Errorf("items = %s, want []", raw["items"])
	}
}

func TestListParticipantsClampsPerPage(t *testing.T) {
	fake := &fakeParticipantStore{}
	h := newParticipantsTestHandler(t, fake)
	rec := getParticipants(h, "/sequences/seq-1/participants?per_page=9999", "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if fake.gotQuery.PerPage != participantsMaxPerPage {
		t.Errorf("per_page = %d, want clamp to %d", fake.gotQuery.PerPage, participantsMaxPerPage)
	}
}
