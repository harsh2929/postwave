// SPDX-License-Identifier: AGPL-3.0-only
package agent_routines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fakeStore implements the handler-facing Store.
type fakeStore struct {
	routines map[string]*Routine
	runs     []Run

	created    []CreateInput
	createdBy  string
	createErr  error
	updated    []UpdateInput
	updateErr  error
	deleteErr  error
	deletedIDs []string
}

func newFakeStore(routines ...*Routine) *fakeStore {
	m := map[string]*Routine{}
	for _, rt := range routines {
		m[rt.ID] = rt
	}
	return &fakeStore{routines: m}
}

func (f *fakeStore) CreateRoutine(_ context.Context, _ string, in CreateInput, createdBy string) (*Routine, error) {
	if f.createErr != nil {
		return nil, f.createErr
	}
	for _, rt := range f.routines {
		if rt.Name == in.Name {
			return nil, ErrNameTaken
		}
	}
	f.created = append(f.created, in)
	f.createdBy = createdBy
	rt := &Routine{ID: "rt-new", Name: in.Name, Prompt: in.Prompt, Kind: in.Kind, Schedule: in.Schedule, Enabled: true, RequireApproval: true}
	if in.RequireApproval != nil {
		rt.RequireApproval = *in.RequireApproval
	}
	f.routines[rt.ID] = rt
	return rt, nil
}

func (f *fakeStore) ListRoutines(context.Context, string) ([]Routine, error) {
	out := []Routine{}
	for _, rt := range f.routines {
		out = append(out, *rt)
	}
	return out, nil
}

func (f *fakeStore) GetRoutine(_ context.Context, _, id string) (*Routine, error) {
	rt, ok := f.routines[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *rt
	return &cp, nil
}

func (f *fakeStore) UpdateRoutine(_ context.Context, _, id string, in UpdateInput) (*Routine, error) {
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	rt, ok := f.routines[id]
	if !ok {
		return nil, ErrNotFound
	}
	f.updated = append(f.updated, in)
	cp := *rt
	if in.Name != nil {
		cp.Name = *in.Name
	}
	if in.Enabled != nil {
		cp.Enabled = *in.Enabled
	}
	return &cp, nil
}

func (f *fakeStore) DeleteRoutine(_ context.Context, _, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	if _, ok := f.routines[id]; !ok {
		return ErrNotFound
	}
	delete(f.routines, id)
	f.deletedIDs = append(f.deletedIDs, id)
	return nil
}

func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]Run, error) {
	return f.runs, nil
}

func (f *fakeStore) GetRunByApproval(_ context.Context, _, approvalID string) (*Run, error) {
	for i := range f.runs {
		if f.runs[i].ApprovalID == approvalID {
			r := f.runs[i]
			return &r, nil
		}
	}
	return nil, ErrNotFound
}

// ---- helpers ------------------------------------------------------------

func tenantRequest(t *testing.T, method, target, body string, params map[string]string) *http.Request {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1", Slug: "t1"})
	if len(params) > 0 {
		rctx := chi.NewRouteContext()
		for k, v := range params {
			rctx.URLParams.Add(k, v)
		}
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return req.WithContext(ctx)
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	out := map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (%s)", err, rec.Body.String())
	}
	return out
}

// ---- Create -------------------------------------------------------------

func TestCreate_ValidationErrors(t *testing.T) {
	d := &Deps{Store: newFakeStore()}
	cases := []struct {
		name string
		body string
	}{
		{"missing name", `{"prompt":"p","kind":"draft_campaign"}`},
		{"missing prompt", `{"name":"n","kind":"draft_campaign"}`},
		{"bad kind", `{"name":"n","prompt":"p","kind":"send_campaign"}`},
		{"bad schedule", `{"name":"n","prompt":"p","kind":"draft_campaign","schedule":"hourly"}`},
		{"name too long", `{"name":"` + strings.Repeat("x", 201) + `","prompt":"p","kind":"draft_campaign"}`},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		d.Create(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines", tc.body, nil))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", tc.name, rec.Code)
		}
	}
}

func TestCreate_OK(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Create(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines",
		`{"name":"Weekly digest","prompt":"draft it","kind":"DRAFT_CAMPAIGN"}`, nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	if out["require_approval"] != true {
		t.Fatalf("require_approval should default true: %v", out)
	}
	if len(store.created) != 1 {
		t.Fatalf("store.created = %d, want 1", len(store.created))
	}
	// Normalization: kind lowercased, schedule defaulted to manual.
	if store.created[0].Kind != KindDraftCampaign || store.created[0].Schedule != ScheduleManual {
		t.Fatalf("normalized input = %+v", store.created[0])
	}
}

func TestCreate_NameConflict(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "dup"})
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Create(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines",
		`{"name":"dup","prompt":"p","kind":"draft_campaign"}`, nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestCreate_InvalidTargetSegmentIsSafeValidationError(t *testing.T) {
	store := newFakeStore()
	store.createErr = ErrInvalidTargetSegment
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Create(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines",
		`{"name":"targeted","prompt":"p","kind":"draft_campaign","target_segment_id":"other-tenant-id"}`, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	errBody, _ := out["error"].(map[string]any)
	if errBody["code"] != "invalid_target_segment" ||
		errBody["message"] != "target segment is not available in this workspace" {
		t.Fatalf("unsafe/unexpected error body: %v", out)
	}
	if strings.Contains(rec.Body.String(), "other-tenant-id") {
		t.Fatalf("response reflected target id: %s", rec.Body.String())
	}
}

func TestCreate_UnsupportedTargetListIsSafeValidationError(t *testing.T) {
	store := newFakeStore()
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Create(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines",
		`{"name":"targeted","prompt":"p","kind":"draft_campaign","target_list_id":"42"}`, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	errBody, _ := out["error"].(map[string]any)
	if errBody["code"] != "unsupported_target_list" ||
		errBody["message"] != "list targeting is not supported for agent routines; use a canonical segment or leave it empty" {
		t.Fatalf("unsafe/unexpected error body: %v", out)
	}
	if strings.Contains(rec.Body.String(), `"42"`) {
		t.Fatalf("response reflected target id: %s", rec.Body.String())
	}
	if len(store.created) != 0 {
		t.Fatalf("store create calls = %d, want 0", len(store.created))
	}
}

func TestHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Store: newFakeStore()}
	for name, h := range map[string]http.HandlerFunc{
		"list": d.List, "create": d.Create, "get": d.Get,
		"update": d.Update, "delete": d.Delete, "run": d.RunNow, "runs": d.ListRuns,
	} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/api/v1/agent-routines", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401 without tenant", name, rec.Code)
		}
	}
}

// ---- Update / Delete ------------------------------------------------------

func TestUpdate_Validation(t *testing.T) {
	d := &Deps{Store: newFakeStore(&Routine{ID: "rt-1", Name: "n"})}
	rec := httptest.NewRecorder()
	d.Update(rec, tenantRequest(t, http.MethodPatch, "/api/v1/agent-routines/rt-1",
		`{"schedule":"hourly"}`, map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}

func TestUpdate_NotFound(t *testing.T) {
	d := &Deps{Store: newFakeStore()}
	rec := httptest.NewRecorder()
	d.Update(rec, tenantRequest(t, http.MethodPatch, "/api/v1/agent-routines/missing",
		`{"name":"x"}`, map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestUpdate_InvalidTargetSegmentIsSafeValidationError(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "n"})
	store.updateErr = ErrInvalidTargetSegment
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Update(rec, tenantRequest(t, http.MethodPatch, "/api/v1/agent-routines/rt-1",
		`{"target_segment_id":"missing-id"}`, map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	errBody, _ := out["error"].(map[string]any)
	if errBody["code"] != "invalid_target_segment" ||
		errBody["message"] != "target segment is not available in this workspace" {
		t.Fatalf("unsafe/unexpected error body: %v", out)
	}
}

func TestUpdate_UnsupportedTargetListIsSafeValidationError(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "n"})
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Update(rec, tenantRequest(t, http.MethodPatch, "/api/v1/agent-routines/rt-1",
		`{"target_list_id":"00000000-0000-4000-8000-000000000042"}`, map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	errBody, _ := out["error"].(map[string]any)
	if errBody["code"] != "unsupported_target_list" {
		t.Fatalf("unexpected error body: %v", out)
	}
	if len(store.updated) != 0 {
		t.Fatalf("store update calls = %d, want 0", len(store.updated))
	}
}

func TestDelete_OKAndNotFound(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "n"})
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.Delete(rec, tenantRequest(t, http.MethodDelete, "/api/v1/agent-routines/rt-1", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	rec = httptest.NewRecorder()
	d.Delete(rec, tenantRequest(t, http.MethodDelete, "/api/v1/agent-routines/rt-1", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, want 404", rec.Code)
	}
}

func TestUpdateAndDelete_409WhileRunActive(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "n"})
	store.updateErr = ErrRoutineActive
	store.deleteErr = ErrRoutineActive
	d := &Deps{Store: store}

	update := httptest.NewRecorder()
	d.Update(update, tenantRequest(t, http.MethodPatch,
		"/api/v1/agent-routines/rt-1", `{"name":"changed"}`,
		map[string]string{"id": "rt-1"}))
	if update.Code != http.StatusConflict {
		t.Fatalf("update status = %d, want 409: %s", update.Code, update.Body.String())
	}
	deleteRec := httptest.NewRecorder()
	d.Delete(deleteRec, tenantRequest(t, http.MethodDelete,
		"/api/v1/agent-routines/rt-1", "", map[string]string{"id": "rt-1"}))
	if deleteRec.Code != http.StatusConflict {
		t.Fatalf("delete status = %d, want 409: %s", deleteRec.Code, deleteRec.Body.String())
	}
	for _, rec := range []*httptest.ResponseRecorder{update, deleteRec} {
		body := decodeBody(t, rec)
		errBody, _ := body["error"].(map[string]any)
		if errBody["code"] != "routine_active" ||
			errBody["message"] != "this agent routine has an active run; wait for it to finish before retrying" {
			t.Fatalf("unexpected conflict body: %v", body)
		}
	}
}

// ---- RunNow ----------------------------------------------------------------

func TestRunNow_404OnMissingRoutine(t *testing.T) {
	d := &Deps{
		Store:  newFakeStore(),
		Runner: &Runner{Store: newFakeRunnerStore(), Voice: &fakeVoice{}},
	}
	rec := httptest.NewRecorder()
	d.RunNow(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines/missing/run", "", map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestRunNow_503WhenRunnerMissing(t *testing.T) {
	d := &Deps{Store: newFakeStore(&Routine{ID: "rt-1", Name: "n"})}
	rec := httptest.NewRecorder()
	d.RunNow(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines/rt-1/run", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestRunNow_202WithRunID(t *testing.T) {
	rt := campaignRoutine(false)
	runnerStore := newFakeRunnerStore(rt)
	d := &Deps{
		Store: newFakeStore(rt),
		Runner: &Runner{
			Store: runnerStore,
			Voice: &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}},
		},
	}
	rec := httptest.NewRecorder()
	d.RunNow(rec, tenantRequest(t, http.MethodPost, "/api/v1/agent-routines/rt-1/run", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	if out["run_id"] != "run-rt-1" || out["status"] != RunStatusRunning {
		t.Fatalf("body = %v", out)
	}
	// The detached goroutine must finish the run.
	deadline := time.Now().Add(3 * time.Second)
	for {
		runnerStore.mu.Lock()
		n := len(runnerStore.finished)
		runnerStore.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("detached run never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if fin := runnerStore.lastFinished(t); fin.Status != RunStatusSucceeded {
		t.Fatalf("detached run status = %q (err=%q)", fin.Status, fin.ErrMsg)
	}
}

func TestRunNow_409WhenRoutineAlreadyRunningWithoutModelSpend(t *testing.T) {
	rt := campaignRoutine(false)
	runnerStore := newFakeRunnerStore(rt)
	runnerStore.insertErr = ErrRoutineActive
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}}
	d := &Deps{
		Store: newFakeStore(rt),
		Runner: &Runner{
			Store: runnerStore,
			Voice: voice,
		},
	}
	rec := httptest.NewRecorder()
	d.RunNow(rec, tenantRequest(t, http.MethodPost,
		"/api/v1/agent-routines/rt-1/run", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "routine_active" {
		t.Fatalf("body = %v, want routine_active", body)
	}
	voice.mu.Lock()
	defer voice.mu.Unlock()
	if len(voice.generateCalls) != 0 || len(voice.briefs) != 0 || len(voice.created) != 0 {
		t.Fatalf("active conflict spent model work: %+v", voice)
	}
}

func TestRunNow_PanicFinalizesRun(t *testing.T) {
	rt := campaignRoutine(false)
	runnerStore := newFakeRunnerStore(rt)
	d := &Deps{
		Store: newFakeStore(rt),
		Runner: &Runner{
			Store: runnerStore,
			Voice: &panicOnceVoice{},
		},
	}
	rec := httptest.NewRecorder()
	d.RunNow(rec, tenantRequest(t, http.MethodPost,
		"/api/v1/agent-routines/rt-1/run", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		runnerStore.mu.Lock()
		finished := len(runnerStore.finished)
		runnerStore.mu.Unlock()
		if finished == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("panicked detached run stayed running")
		}
		time.Sleep(5 * time.Millisecond)
	}
	finished := runnerStore.lastFinished(t)
	if finished.Status != RunStatusFailed || finished.ErrMsg != unexpectedExecutionError {
		t.Fatalf("panic receipt=%+v", finished)
	}
	if strings.Contains(finished.ErrMsg, "provider payload") {
		t.Fatalf("panic value leaked into receipt: %q", finished.ErrMsg)
	}
}

// ---- ListRuns ----------------------------------------------------------------

func TestListRuns_404OnMissingRoutine(t *testing.T) {
	d := &Deps{Store: newFakeStore()}
	rec := httptest.NewRecorder()
	d.ListRuns(rec, tenantRequest(t, http.MethodGet, "/api/v1/agent-routines/missing/runs", "", map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestListRuns_OK(t *testing.T) {
	store := newFakeStore(&Routine{ID: "rt-1", Name: "n"})
	store.runs = []Run{{ID: "run-1", RoutineID: "rt-1", Status: RunStatusSucceeded, OutputKind: OutputCampaign, OutputRef: "c-1"}}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.ListRuns(rec, tenantRequest(t, http.MethodGet, "/api/v1/agent-routines/rt-1/runs", "", map[string]string{"id": "rt-1"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := decodeBody(t, rec)
	items, _ := out["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", out)
	}
}
