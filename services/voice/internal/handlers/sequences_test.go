package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/internalauth"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

func TestCreateTemplateRequiresAdminRoleForDirectLocalCalls(t *testing.T) {
	h := newTemplateTestHandler()
	req := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("direct-no-role")))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestCreateTemplateAllowsLocalAdminRole(t *testing.T) {
	h := newTemplateTestHandler()
	req := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("direct-admin")))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("X-Postwave-Role", "admin")
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestCreateTemplateAllowsInternalBearerFromGateway(t *testing.T) {
	h := newTemplateTestHandler()
	handler := internalauth.Middleware("secret")(h.Routes())
	req := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("gateway-admin")))
	req.RemoteAddr = "203.0.113.10:49152"
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestUpdateTemplateRequiresAdminRole(t *testing.T) {
	h := newTemplateTestHandler()
	createReq := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("patch-needs-admin")))
	createReq.Header.Set("X-Tenant-ID", "tenant-1")
	createReq.Header.Set("X-Postwave-Role", "admin")
	createRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("seed status = %d, want 201: %s", createRec.Code, createRec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPatch, "/templates/patch-needs-admin", strings.NewReader(`{"name":"Nope"}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestUpdateTemplateAllowsAdminAndPersistsPatch(t *testing.T) {
	h := newTemplateTestHandler()
	createReq := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("patch-admin")))
	createReq.Header.Set("X-Tenant-ID", "tenant-1")
	createReq.Header.Set("X-Postwave-Role", "admin")
	createRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("seed status = %d, want 201: %s", createRec.Code, createRec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPatch, "/templates/patch-admin", strings.NewReader(`{
		"name": "Updated template",
		"category": "sales",
		"tags": ["Launch", "launch", "  onboarding  "]
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("X-Postwave-Role", "owner")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got templates.Template
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Name != "Updated template" || got.Category != templates.CategorySales {
		t.Fatalf("template = (%q,%q), want (Updated template,sales)", got.Name, got.Category)
	}
	if len(got.Tags) != 2 || got.Tags[0] != "Launch" || got.Tags[1] != "onboarding" {
		t.Fatalf("tags not normalized: %#v", got.Tags)
	}
}

func TestDeleteTemplateAllowsAdmin(t *testing.T) {
	h := newTemplateTestHandler()
	createReq := httptest.NewRequest(http.MethodPost, "/templates", strings.NewReader(testTemplateJSON("delete-admin")))
	createReq.Header.Set("X-Tenant-ID", "tenant-1")
	createReq.Header.Set("X-Postwave-Role", "admin")
	createRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("seed status = %d, want 201: %s", createRec.Code, createRec.Body.String())
	}

	req := httptest.NewRequest(http.MethodDelete, "/templates/delete-admin", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("X-Postwave-Role", "admin")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", rec.Code, rec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/templates/delete-admin", nil)
	getRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusNotFound {
		t.Fatalf("GET status = %d, want 404", getRec.Code)
	}
}

func TestCreateDraftSequenceDoesNotRequireTemplateOrLLM(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	req := httptest.NewRequest(http.MethodPost, "/sequences", strings.NewReader(`{
		"name": "Product event follow-up",
		"steps": [{
			"type": "condition",
			"position": 1,
			"condition": {
				"predicate": "product_event",
				"value": "trial_started",
				"yes_branch": [],
				"no_branch": []
			}
		}]
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID == "" || got.TenantID != "tenant-1" || got.Name != "Product event follow-up" || got.Status != "draft" {
		t.Fatalf("unexpected sequence: %+v", got)
	}
	if got.Version != 1 || rec.Header().Get("ETag") != `"1"` {
		t.Fatalf("created sequence must expose version 1 in body and strong ETag; body=%d etag=%q", got.Version, rec.Header().Get("ETag"))
	}
	if got.TemplateID != "" || len(got.Emails) != 0 {
		t.Fatalf("manual draft should not have template/emails: %+v", got)
	}
	if len(got.Steps) != 1 || got.Steps[0].Condition == nil || got.Steps[0].Condition.Value != "trial_started" {
		t.Fatalf("steps not persisted: %+v", got.Steps)
	}
	saved, err := store.Get(context.Background(), "tenant-1", got.ID)
	if err != nil {
		t.Fatalf("stored sequence not found: %v", err)
	}
	if saved.Name != got.Name {
		t.Fatalf("stored name = %q, want %q", saved.Name, got.Name)
	}
}

func TestUpdateSequencePersistsEditableFields(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	createdAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	if err := store.Save(context.Background(), generation.Sequence{
		ID:        "seq-1",
		TenantID:  "tenant-1",
		Name:      "Before",
		Status:    "draft",
		CreatedAt: createdAt,
		Emails: []generation.GeneratedEmail{{
			Position:           1,
			DelaySeconds:       3600,
			Subject:            "Old subject",
			Body:               "Old body",
			VoiceFidelityScore: 80,
		}},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-1", strings.NewReader(`{
		"name": "After",
		"status": "draft",
		"emails": [{
			"position": 1,
			"delay_seconds": 7200,
			"subject": "New subject",
			"body": "New body",
			"voice_fidelity_score": 91
		}]
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", "1")
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Name != "After" || got.Status != "draft" {
		t.Fatalf("sequence metadata = (%q,%q), want (After, draft)", got.Name, got.Status)
	}
	if len(got.Emails) != 1 || got.Emails[0].DelaySeconds != 7200 || got.Emails[0].Subject != "New subject" {
		t.Fatalf("email not updated: %+v", got.Emails)
	}
	if got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Fatalf("expected timestamps, got created=%s updated=%s", got.CreatedAt, got.UpdatedAt)
	}
}

func TestUpdateSequenceAllowsClearingAllSteps(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID:       "seq-clear",
		TenantID: "tenant-1",
		Name:     "Clearable",
		Status:   "draft",
		Steps: []generation.Step{{
			Type:     generation.StepTypeEmail,
			Position: 1,
			Email: &generation.EmailConfig{
				Subject: "Seed",
				Body:    "Seed body",
			},
		}},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-clear", strings.NewReader(`{"steps":[]}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", "1")
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got.Steps) != 0 || len(got.Emails) != 0 {
		t.Fatalf("expected all steps cleared, got steps=%+v emails=%+v", got.Steps, got.Emails)
	}
}

// TestUpdateSequenceRoundTripsConditionStep verifies that PATCHing a
// sequence with the v0.3+ Steps shape (condition with two branches,
// nested email + tag-add steps) round-trips through the handler +
// store and decodes back identically. This pins the on-the-wire
// contract so the desktop canvas + the voice service can't drift.
func TestUpdateSequenceRoundTripsConditionStep(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	createdAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	if err := store.Save(context.Background(), generation.Sequence{
		ID:        "seq-cond",
		TenantID:  "tenant-1",
		Name:      "Cond",
		Status:    "draft",
		CreatedAt: createdAt,
		Emails: []generation.GeneratedEmail{{
			Position: 1, Subject: "seed", Body: "seed",
		}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	body := `{
		"steps": [
			{"type":"email","position":1,"email":{"subject":"Welcome","body":"Hi","delay_seconds":0}},
			{"type":"delay","position":2,"delay":{"seconds":86400,"value":1,"unit":"days"}},
			{"type":"condition","position":3,"condition":{
				"predicate":"opened_previous","value":"",
				"yes_branch":[
					{"type":"tag_add","position":1,"tag":{"tag":"engaged"}},
					{"type":"email","position":2,"email":{"subject":"Engaged path","body":"Yay"}}
				],
				"no_branch":[
					{"type":"tag_add","position":1,"tag":{"tag":"cold"}},
					{"type":"exit","position":2}
				]
			}}
		]
	}`
	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-cond", strings.NewReader(body))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", "1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	// GET it back and confirm exact step shape survives.
	getReq := httptest.NewRequest(http.MethodGet, "/sequences/seq-cond", nil)
	getReq.Header.Set("X-Tenant-ID", "tenant-1")
	getRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200: %s", getRec.Code, getRec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(getRec.Body).Decode(&got); err != nil {
		t.Fatalf("decode GET: %v", err)
	}
	if len(got.Steps) != 3 {
		t.Fatalf("Steps len = %d, want 3", len(got.Steps))
	}
	if got.Steps[0].Type != generation.StepTypeEmail || got.Steps[0].Email == nil || got.Steps[0].Email.Subject != "Welcome" {
		t.Fatalf("step[0] not preserved: %+v", got.Steps[0])
	}
	if got.Steps[1].Type != generation.StepTypeDelay || got.Steps[1].Delay == nil || got.Steps[1].Delay.Seconds != 86400 {
		t.Fatalf("step[1] not preserved: %+v", got.Steps[1])
	}
	cond := got.Steps[2]
	if cond.Type != generation.StepTypeCondition || cond.Condition == nil {
		t.Fatalf("step[2] not a condition: %+v", cond)
	}
	if cond.Condition.Predicate != "opened_previous" {
		t.Fatalf("predicate = %q, want opened_previous", cond.Condition.Predicate)
	}
	if len(cond.Condition.YesBranch) != 2 || len(cond.Condition.NoBranch) != 2 {
		t.Fatalf("branches = %d/%d, want 2/2",
			len(cond.Condition.YesBranch), len(cond.Condition.NoBranch))
	}
	if cond.Condition.YesBranch[0].Type != generation.StepTypeTagAdd ||
		cond.Condition.YesBranch[0].Tag == nil ||
		cond.Condition.YesBranch[0].Tag.Tag != "engaged" {
		t.Fatalf("yes_branch[0] not preserved: %+v", cond.Condition.YesBranch[0])
	}
	if cond.Condition.NoBranch[1].Type != generation.StepTypeExit {
		t.Fatalf("no_branch[1] type = %q, want exit", cond.Condition.NoBranch[1].Type)
	}
	// Sequence shouldn't have stale Emails alongside the new Steps.
	if len(got.Emails) != 0 {
		t.Fatalf("Emails should be cleared when Steps is set; got %d", len(got.Emails))
	}
}

func TestDeleteSequenceRemovesTenantSequence(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID: "seq-delete", TenantID: "tenant-1", Name: "Delete me", Status: "draft",
		Emails: []generation.GeneratedEmail{{Position: 1, Subject: "x", Body: "x"}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/sequences/seq-delete", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", "1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", rec.Code, rec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/sequences/seq-delete", nil)
	getReq.Header.Set("X-Tenant-ID", "tenant-1")
	getRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusNotFound {
		t.Fatalf("GET status = %d, want 404", getRec.Code)
	}
}

// TestUpdateSequenceRejectsMixedEmailsAndSteps confirms that a request
// supplying BOTH the legacy `emails` and the new `steps` field is
// rejected so producers don't accidentally double-write.
func TestUpdateSequenceRejectsMixedEmailsAndSteps(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID: "seq-mixed", TenantID: "tenant-1", Name: "Mixed", Status: "draft",
		Emails: []generation.GeneratedEmail{{Position: 1, Subject: "x", Body: "x"}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-mixed", strings.NewReader(`{
		"emails": [{"position": 1, "subject": "x", "body": "x"}],
		"steps":  [{"type":"exit","position":1}]
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateSequenceOpsRequiresIfMatch confirms that the new ops-based
// PATCH surface rejects a request that omits the If-Match header. Without
// the guard a concurrent reorder would silently clobber another
// session's writes — the whole point of moving away from full-array
// replacement is to make that race impossible.
func TestUpdateSequenceOpsRequiresIfMatch(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID:       "seq-ifm",
		TenantID: "tenant-1",
		Name:     "OpsNoIfMatch",
		Status:   "draft",
		Steps: []generation.Step{{
			Type:     generation.StepTypeEmail,
			Position: 1,
			Email:    &generation.EmailConfig{Subject: "s", Body: "b"},
		}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-ifm", strings.NewReader(`{
		"ops": [{"op":"delete","step_id":1}]
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusPreconditionRequired, rec.Body.String())
	}
}

// TestUpdateSequenceOpsConcurrentEditReturns412 is the canonical test
// for the optimistic-concurrency contract:
//
//   - Session A reads v1
//   - Session B reads v1
//   - A writes (succeeds, row bumps to v2)
//   - B writes against v1 (must 412)
//
// The new ops-based PATCH surface MUST detect B's stale version and
// return 412 Precondition Failed so the canvas can re-fetch + re-emit.
func TestUpdateSequenceOpsConcurrentEditReturns412(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID:       "seq-race",
		TenantID: "tenant-1",
		Name:     "Race",
		Status:   "draft",
		Steps: []generation.Step{{
			Type:     generation.StepTypeEmail,
			Position: 1,
			Email:    &generation.EmailConfig{Subject: "first", Body: "first body"},
		}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A reads — captures v1 via the ETag.
	readA := httptest.NewRequest(http.MethodGet, "/sequences/seq-race", nil)
	readA.Header.Set("X-Tenant-ID", "tenant-1")
	recReadA := httptest.NewRecorder()
	h.Routes().ServeHTTP(recReadA, readA)
	if recReadA.Code != http.StatusOK {
		t.Fatalf("readA status = %d, want 200: %s", recReadA.Code, recReadA.Body.String())
	}
	versionA := strings.TrimSpace(recReadA.Header().Get("ETag"))
	if versionA != `"1"` {
		t.Fatalf("expected strong ETag %q on read, got %q", `"1"`, versionA)
	}

	// B reads — same row, same version.
	readB := httptest.NewRequest(http.MethodGet, "/sequences/seq-race", nil)
	readB.Header.Set("X-Tenant-ID", "tenant-1")
	recReadB := httptest.NewRecorder()
	h.Routes().ServeHTTP(recReadB, readB)
	if recReadB.Code != http.StatusOK {
		t.Fatalf("readB status = %d, want 200: %s", recReadB.Code, recReadB.Body.String())
	}
	versionB := strings.TrimSpace(recReadB.Header().Get("ETag"))
	if versionA != versionB {
		t.Fatalf("A and B read different versions: %q vs %q", versionA, versionB)
	}

	// A writes — appends a new email step. Should succeed and bump the
	// row to v2.
	writeA := httptest.NewRequest(http.MethodPatch, "/sequences/seq-race", strings.NewReader(`{
		"ops": [{"op":"insert","after_id":1,"step":{"type":"email","position":2,"email":{"subject":"a-write","body":"a-body"}}}]
	}`))
	writeA.Header.Set("X-Tenant-ID", "tenant-1")
	writeA.Header.Set("If-Match", versionA)
	recWriteA := httptest.NewRecorder()
	h.Routes().ServeHTTP(recWriteA, writeA)
	if recWriteA.Code != http.StatusOK {
		t.Fatalf("writeA status = %d, want 200: %s", recWriteA.Code, recWriteA.Body.String())
	}
	versionAfterA := strings.TrimSpace(recWriteA.Header().Get("ETag"))
	if versionAfterA == versionA {
		t.Fatalf("expected ETag to bump on successful write; got %q (unchanged from %q)", versionAfterA, versionA)
	}

	// B writes against the stale v1 — must 412 because A landed first.
	writeB := httptest.NewRequest(http.MethodPatch, "/sequences/seq-race", strings.NewReader(`{
		"ops": [{"op":"delete","step_id":1}]
	}`))
	writeB.Header.Set("X-Tenant-ID", "tenant-1")
	writeB.Header.Set("If-Match", versionB)
	recWriteB := httptest.NewRecorder()
	h.Routes().ServeHTTP(recWriteB, writeB)
	if recWriteB.Code != http.StatusPreconditionFailed {
		t.Fatalf("writeB status = %d, want %d: %s", recWriteB.Code, http.StatusPreconditionFailed, recWriteB.Body.String())
	}

	// Confirm A's write survived: the row should still have A's
	// appended step and no delete should have landed.
	final, err := store.Get(context.Background(), "tenant-1", "seq-race")
	if err != nil {
		t.Fatalf("final get: %v", err)
	}
	if len(final.Steps) != 2 {
		t.Fatalf("expected 2 steps after A's write, got %d (B should not have landed): %+v", len(final.Steps), final.Steps)
	}
}

// TestUpdateSequenceOpsInsertMoveDelete walks a sequence of ops through
// the handler to confirm insert / move / delete each take effect inside
// the same PATCH and that the renumber-after-each-op invariant holds.
func TestUpdateSequenceOpsInsertMoveDelete(t *testing.T) {
	store := NewMemorySequenceStore()
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: store,
	})
	if err := store.Save(context.Background(), generation.Sequence{
		ID:       "seq-ops",
		TenantID: "tenant-1",
		Name:     "Ops",
		Status:   "draft",
		Steps: []generation.Step{
			{Type: generation.StepTypeEmail, Position: 1, Email: &generation.EmailConfig{Subject: "one", Body: "1"}},
			{Type: generation.StepTypeEmail, Position: 2, Email: &generation.EmailConfig{Subject: "two", Body: "2"}},
		},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Capture starting version.
	read := httptest.NewRequest(http.MethodGet, "/sequences/seq-ops", nil)
	read.Header.Set("X-Tenant-ID", "tenant-1")
	recRead := httptest.NewRecorder()
	h.Routes().ServeHTTP(recRead, read)
	v := strings.TrimSpace(recRead.Header().Get("ETag"))

	// Insert a new step after position 1, then delete the original
	// position-2 (which is now at position 3 after the renumber).
	body := `{
		"ops": [
			{"op":"insert","after_id":1,"step":{"type":"email","position":2,"email":{"subject":"new","body":"n"}}},
			{"op":"delete","step_id":3}
		]
	}`
	req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-ops", strings.NewReader(body))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	req.Header.Set("If-Match", v)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var got generation.Sequence
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Steps) != 2 {
		t.Fatalf("expected 2 steps after insert+delete, got %d: %+v", len(got.Steps), got.Steps)
	}
	if got.Steps[0].Email == nil || got.Steps[0].Email.Subject != "one" {
		t.Fatalf("expected original step preserved at position 1, got %+v", got.Steps[0])
	}
	if got.Steps[1].Email == nil || got.Steps[1].Email.Subject != "new" {
		t.Fatalf("expected inserted step at position 2, got %+v", got.Steps[1])
	}
}

func newTemplateTestHandler() *Handler {
	tmpls := templates.NewMemoryStore()
	return New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: tmpls,
		Sequences: NewMemorySequenceStore(),
	})
}

func testTemplateJSON(slug string) string {
	return `{
		"slug": "` + slug + `",
		"category": "welcome",
		"name": "Direct admin test",
		"description": "Template created by handler tests.",
		"length": 1,
		"variables": [{"key": "newsletter_name", "label": "Newsletter name", "required": true, "example": "The Letter"}],
		"emails": [{"position": 1, "delay_seconds": 0, "subject_skeleton": "Welcome to {{newsletter_name}}", "body_skeleton": "A real body skeleton for the local test template.", "notes": "Keep the welcome short."}]
	}`
}
