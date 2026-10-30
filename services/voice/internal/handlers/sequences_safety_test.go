package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/seqstore"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

type forcedProductionVersionMismatchStore struct {
	SequenceStore
}

type unversionedSequenceStore struct {
	SequenceStore
}

// noFollowupReadStore rejects a second read so the success-path test can pin
// the invariant that a PATCH response describes its own CAS commit, not a
// later writer observed by a post-commit GET.
type noFollowupReadStore struct {
	*MemorySequenceStore
	getCalls int
}

func (s *noFollowupReadStore) Get(ctx context.Context, tenantID, id string) (generation.Sequence, error) {
	s.getCalls++
	if s.getCalls > 1 {
		return generation.Sequence{}, context.Canceled
	}
	return s.MemorySequenceStore.Get(ctx, tenantID, id)
}

func (s *forcedProductionVersionMismatchStore) SaveWithVersion(
	context.Context,
	generation.Sequence,
	int64,
) (int64, error) {
	return 0, seqstore.ErrVersionMismatch
}

func TestUpdateSequenceMapsProductionVersionMismatchToPreconditionFailed(t *testing.T) {
	memory := NewMemorySequenceStore()
	if err := memory.Save(context.Background(), generation.Sequence{
		ID: "seq-production-sentinel", TenantID: "tenant-1", Name: "Before", Status: "draft",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := &forcedProductionVersionMismatchStore{SequenceStore: memory}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})

	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-production-sentinel", strings.NewReader(`{"name":"After"}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", "1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "reload and retry") {
		t.Fatalf("response should explain recovery, got %q", rec.Body.String())
	}
	stored, err := memory.Get(context.Background(), "tenant-1", "seq-production-sentinel")
	if err != nil {
		t.Fatalf("get stored sequence: %v", err)
	}
	if stored.Name != "Before" || stored.Version != 1 {
		t.Fatalf("stale write changed the sequence: %+v", stored)
	}
}

func TestSequenceMutationsFailClosedWhenStoreLacksCAS(t *testing.T) {
	memory := NewMemorySequenceStore()
	if err := memory.Save(context.Background(), generation.Sequence{
		ID: "seq-no-cas", TenantID: "tenant-1", Name: "Before", Status: "draft",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := &unversionedSequenceStore{SequenceStore: memory}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})

	for _, tc := range []struct {
		name   string
		method string
		body   string
	}{
		{name: "patch", method: http.MethodPatch, body: `{"name":"After"}`},
		{name: "delete", method: http.MethodDelete},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/sequences/seq-no-cas", strings.NewReader(tc.body))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			req.Header.Set("If-Match", "1")
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
			}
		})
	}
	stored, err := memory.Get(context.Background(), "tenant-1", "seq-no-cas")
	if err != nil {
		t.Fatalf("get stored sequence: %v", err)
	}
	if stored.Name != "Before" || stored.Version != 1 {
		t.Fatalf("unsupported CAS store changed the sequence: %+v", stored)
	}
}

func TestUpdateSequenceAcknowledgesExactCASRevisionWithoutFollowupRead(t *testing.T) {
	memory := NewMemorySequenceStore()
	if err := memory.Save(context.Background(), generation.Sequence{
		ID: "seq-cas-ack", TenantID: "tenant-1", Name: "Before", Status: "draft",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := &noFollowupReadStore{MemorySequenceStore: memory}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})

	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-cas-ack", strings.NewReader(`{"name":"After"}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", `"1"`)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.getCalls != 1 {
		t.Fatalf("store Get calls = %d, want exactly the pre-CAS read", store.getCalls)
	}
	if got := rec.Header().Get("ETag"); got != `"2"` {
		t.Fatalf("ETag = %q, want %q", got, `"2"`)
	}
	var body generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Name != "After" || body.Version != 2 {
		t.Fatalf("response did not describe exact CAS commit: %+v", body)
	}
}

func TestDeleteSequenceRequiresCurrentVersion(t *testing.T) {
	store := NewMemorySequenceStore()
	if err := store.Save(context.Background(), generation.Sequence{
		ID: "seq-delete-cas", TenantID: "tenant-1", Name: "Before", Status: "draft",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})

	missing := httptest.NewRequest(http.MethodDelete, "/sequences/seq-delete-cas", nil)
	missing.Header.Set("X-Tenant-ID", "tenant-1")
	missingRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(missingRec, missing)
	if missingRec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing status = %d, want 428: %s", missingRec.Code, missingRec.Body.String())
	}

	update := httptest.NewRequest(http.MethodPatch, "/sequences/seq-delete-cas", strings.NewReader(`{"name":"Changed"}`))
	update.Header.Set("X-Tenant-ID", "tenant-1")
	update.Header.Set("If-Match", "1")
	updateRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(updateRec, update)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200: %s", updateRec.Code, updateRec.Body.String())
	}

	stale := httptest.NewRequest(http.MethodDelete, "/sequences/seq-delete-cas", nil)
	stale.Header.Set("X-Tenant-ID", "tenant-1")
	stale.Header.Set("If-Match", "1")
	staleRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(staleRec, stale)
	if staleRec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale status = %d, want 412: %s", staleRec.Code, staleRec.Body.String())
	}
	if _, err := store.Get(context.Background(), "tenant-1", "seq-delete-cas"); err != nil {
		t.Fatalf("stale delete removed sequence: %v", err)
	}

	current := httptest.NewRequest(http.MethodDelete, "/sequences/seq-delete-cas", nil)
	current.Header.Set("X-Tenant-ID", "tenant-1")
	current.Header.Set("If-Match", "2")
	currentRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(currentRec, current)
	if currentRec.Code != http.StatusNoContent {
		t.Fatalf("current status = %d, want 204: %s", currentRec.Code, currentRec.Body.String())
	}
}

func TestUpdateSequenceOnlyEditsDraftsAndArchivesExclusively(t *testing.T) {
	for _, status := range []string{"active", "archived"} {
		t.Run("stored_"+status, func(t *testing.T) {
			store := NewMemorySequenceStore()
			if err := store.Save(context.Background(), generation.Sequence{
				ID: "seq-locked", TenantID: "tenant-1", Name: "Locked", Status: status,
			}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
				Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
			})
			req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-locked", strings.NewReader(`{"name":"Changed"}`))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			req.Header.Set("If-Match", "1")
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
			}
			stored, err := store.Get(context.Background(), "tenant-1", "seq-locked")
			if err != nil || stored.Name != "Locked" || stored.Version != 1 {
				t.Fatalf("locked row changed: seq=%+v err=%v", stored, err)
			}
		})
	}

	store := NewMemorySequenceStore()
	if err := store.Save(context.Background(), generation.Sequence{
		ID: "seq-archive-only", TenantID: "tenant-1", Name: "Draft", Status: "draft",
	}); err != nil {
		t.Fatalf("seed archive draft: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})
	bundled := httptest.NewRequest(http.MethodPatch, "/sequences/seq-archive-only", strings.NewReader(`{"status":"archived","name":"Also changed"}`))
	bundled.Header.Set("X-Tenant-ID", "tenant-1")
	bundled.Header.Set("If-Match", "1")
	bundledRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(bundledRec, bundled)
	if bundledRec.Code != http.StatusBadRequest {
		t.Fatalf("bundled archive status = %d, want 400: %s", bundledRec.Code, bundledRec.Body.String())
	}

	archive := httptest.NewRequest(http.MethodPatch, "/sequences/seq-archive-only", strings.NewReader(`{"status":"archived"}`))
	archive.Header.Set("X-Tenant-ID", "tenant-1")
	archive.Header.Set("If-Match", "1")
	archiveRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(archiveRec, archive)
	if archiveRec.Code != http.StatusOK {
		t.Fatalf("exclusive archive status = %d, want 200: %s", archiveRec.Code, archiveRec.Body.String())
	}
	if got := archiveRec.Header().Get("ETag"); got != `"2"` {
		t.Fatalf("archive ETag = %q, want strong ETag %q", got, `"2"`)
	}
	stored, err := store.Get(context.Background(), "tenant-1", "seq-archive-only")
	if err != nil || stored.Status != "archived" || stored.Name != "Draft" || stored.Version != 2 {
		t.Fatalf("archive result = %+v, err=%v", stored, err)
	}
}

func TestParseSequenceIfMatchRejectsUnsafeTokens(t *testing.T) {
	for _, token := range []string{"*", `W/"1"`, "1, 2", "0", "-1", "abc", `"1`} {
		t.Run(token, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/sequences/seq", nil)
			req.Header.Set("If-Match", token)
			rec := httptest.NewRecorder()
			if _, ok := parseSequenceIfMatch(rec, req); ok {
				t.Fatalf("token %q unexpectedly accepted", token)
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("token %q status = %d, want 400", token, rec.Code)
			}
		})
	}
	for _, token := range []string{"1", `"2"`} {
		t.Run("accept_"+token, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/sequences/seq", nil)
			req.Header.Set("If-Match", token)
			rec := httptest.NewRecorder()
			if _, ok := parseSequenceIfMatch(rec, req); !ok {
				t.Fatalf("token %q rejected: %s", token, rec.Body.String())
			}
		})
	}
}

func TestSequenceHandlersRejectLiveStatusesBeforePersistence(t *testing.T) {
	for _, status := range []string{"active", "paused"} {
		t.Run("create_"+status, func(t *testing.T) {
			store := NewMemorySequenceStore()
			h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
				Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
			})
			req := httptest.NewRequest(http.MethodPost, "/sequences", strings.NewReader(`{"name":"Runtime blocked","status":"`+status+`"}`))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)

			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
			}
			rows, err := store.List(context.Background(), "tenant-1")
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			if len(rows) != 0 {
				t.Fatalf("unsupported status persisted a row: %+v", rows)
			}
		})

		t.Run("update_"+status, func(t *testing.T) {
			store := NewMemorySequenceStore()
			if err := store.Save(context.Background(), generation.Sequence{
				ID: "seq-pause", TenantID: "tenant-1", Name: "Draft", Status: "draft",
			}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
				Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
			})
			req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-pause", strings.NewReader(`{"status":"`+status+`"}`))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)

			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
			}
			stored, err := store.Get(context.Background(), "tenant-1", "seq-pause")
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			if stored.Status != "draft" || stored.Version != 1 {
				t.Fatalf("unsupported transition changed the row: %+v", stored)
			}
		})
	}
}

type previewFidelityEvaluator struct{}

func (previewFidelityEvaluator) Score(
	context.Context,
	string,
	profile.VoiceProfile,
) (float64, generation.FidelityBreakdown, error) {
	return 91, generation.FidelityBreakdown{Combined: 91}, nil
}

type countingSequenceJobStore struct {
	createCalls int
}

func (s *countingSequenceJobStore) Create(context.Context, string, string, *int, any) (string, error) {
	s.createCalls++
	return "unexpected-job", nil
}
func (*countingSequenceJobStore) Start(context.Context, string, string) error { return nil }
func (*countingSequenceJobStore) Succeed(context.Context, string, string, string) error {
	return nil
}
func (*countingSequenceJobStore) Fail(context.Context, string, string, string) error { return nil }
func (*countingSequenceJobStore) Get(context.Context, string, string) (SequenceJob, error) {
	return SequenceJob{}, nil
}

func TestTemplateBackedGenerationFailsClosedWithoutDurableWorker(t *testing.T) {
	sequenceStore := NewMemorySequenceStore()
	jobs := &countingSequenceJobStore{}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: sequenceStore,
	}).WithSequenceJobs(jobs)

	req := httptest.NewRequest(http.MethodPost, "/sequences", strings.NewReader(`{"template_id":"public-welcome-example","name":"Unsafe async"}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "durable worker") {
		t.Fatalf("response should identify the unavailable durable worker: %q", rec.Body.String())
	}
	if jobs.createCalls != 0 {
		t.Fatalf("fail-closed request created %d detached job(s)", jobs.createCalls)
	}
	rows, err := sequenceStore.List(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("list sequences: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("fail-closed request persisted sequences: %+v", rows)
	}
}

func TestSequenceCreationRejectsUnknownAndModeInapplicableFields(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "unknown field", body: `{"name":"Draft","naem":"typo"}`},
		{name: "client tenant", body: `{"name":"Draft","tenant_id":"other"}`},
		{name: "manual profile", body: `{"name":"Draft","profile":{}}`},
		{name: "manual variables", body: `{"name":"Draft","variables":{}}`},
		{name: "manual style controls", body: `{"name":"Draft","style_controls":{}}`},
		{name: "explicit empty template", body: `{"name":"Draft","template_id":""}`},
		{name: "unbounded template", body: `{"name":"Generated","template_id":"` + strings.Repeat("x", sequenceMaxTemplateIDRunes+1) + `"}`},
		{name: "template control character", body: `{"name":"Generated","template_id":"welcome\nother"}`},
		{name: "template with ignored steps", body: `{"name":"Generated","template_id":"welcome","steps":[]}`},
		{name: "template with ignored status", body: `{"name":"Generated","template_id":"welcome","status":"draft"}`},
		{name: "template with ignored goal", body: `{"name":"Generated","template_id":"welcome","goal":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sequenceStore := NewMemorySequenceStore()
			h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
				Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: sequenceStore,
			})
			req := httptest.NewRequest(http.MethodPost, "/sequences", strings.NewReader(tc.body))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			rows, err := sequenceStore.List(context.Background(), "tenant-1")
			if err != nil || len(rows) != 0 {
				t.Fatalf("invalid request persisted rows=%+v err=%v", rows, err)
			}
		})
	}
}

func TestRegenerateEmailReturnsUnpersistedReviewCandidateEvenWithJobsWired(t *testing.T) {
	templateStore, err := templates.SeededMemoryStore()
	if err != nil {
		t.Fatalf("seed templates: %v", err)
	}
	tmpl, err := templateStore.Get(context.Background(), "public-welcome-example")
	if err != nil {
		t.Fatalf("get template: %v", err)
	}
	sequenceStore := NewMemorySequenceStore()
	if err := sequenceStore.Save(context.Background(), generation.Sequence{
		ID:         "seq-preview",
		TenantID:   "tenant-1",
		TemplateID: tmpl.ID,
		Name:       "Welcome",
		Status:     "draft",
		Emails: []generation.GeneratedEmail{{
			Position: 1, Subject: "Original subject", Body: "Original body", RegenerationCount: 2,
		}},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}
	voiceStore := NewMemoryStore()
	if err := voiceStore.SaveProfile(context.Background(), profile.VoiceProfile{TenantID: "tenant-1"}); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"email":{"position":1,"subject":"Candidate subject","body":"Candidate body","delay_seconds":999}
	}`)}
	jobs := &countingSequenceJobStore{}
	h := New(ingest.NewRegistry(), voiceStore, nil).WithGeneration(GenerationDeps{
		Engine:    generation.NewEngine(llm, templateStore, previewFidelityEvaluator{}),
		Templates: templateStore,
		Sequences: sequenceStore,
	}).WithSequenceJobs(jobs)

	req := httptest.NewRequest(http.MethodPost, "/sequences/seq-preview/regenerate/1", strings.NewReader(`{"user_hint":"shorter"}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var candidate generation.GeneratedEmail
	if err := json.NewDecoder(rec.Body).Decode(&candidate); err != nil {
		t.Fatalf("decode candidate: %v", err)
	}
	if candidate.Subject != "Candidate subject" || candidate.Body != "Candidate body" || candidate.Position != 1 {
		t.Fatalf("unexpected candidate: %+v", candidate)
	}
	if candidate.RegenerationCount != 3 {
		t.Fatalf("candidate regeneration_count = %d, want 3", candidate.RegenerationCount)
	}
	if jobs.createCalls != 0 {
		t.Fatalf("regeneration used destructive async job path %d time(s)", jobs.createCalls)
	}
	stored, err := sequenceStore.Get(context.Background(), "tenant-1", "seq-preview")
	if err != nil {
		t.Fatalf("get stored sequence: %v", err)
	}
	if stored.Version != 1 || len(stored.Emails) != 1 || stored.Emails[0].Subject != "Original subject" || stored.Emails[0].Body != "Original body" {
		t.Fatalf("preview mutated the stored sequence before acceptance: %+v", stored)
	}
}

func TestRegenerateEmailFailsClosedForCanvasDraftWithoutTemplateIdentity(t *testing.T) {
	sequenceStore := NewMemorySequenceStore()
	if err := sequenceStore.Save(context.Background(), generation.Sequence{
		ID:       "seq-canvas",
		TenantID: "tenant-1",
		Name:     "Canvas draft",
		Status:   "draft",
		Steps: []generation.Step{{
			Type: generation.StepTypeEmail, Position: 1,
			Email: &generation.EmailConfig{Subject: "Original", Body: "Original body"},
		}},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: sequenceStore,
	})
	req := httptest.NewRequest(http.MethodPost, "/sequences/seq-canvas/regenerate/1", strings.NewReader(`{}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no source template") {
		t.Fatalf("response should explain the fail-closed boundary, got %q", rec.Body.String())
	}
	stored, err := sequenceStore.Get(context.Background(), "tenant-1", "seq-canvas")
	if err != nil {
		t.Fatalf("get stored sequence: %v", err)
	}
	if stored.Version != 1 || stored.Steps[0].Email.Subject != "Original" {
		t.Fatalf("failed preview mutated the sequence: %+v", stored)
	}
}
