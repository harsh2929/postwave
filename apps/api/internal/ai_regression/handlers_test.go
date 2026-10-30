// SPDX-License-Identifier: AGPL-3.0-only
package ai_regression

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ----- fake Store ---------------------------------------------------------

type fakeStore struct {
	golden     []GoldenExample
	goldenIn   []CaptureGoldenInput
	goldenN    int
	runs       []RegressionRun
	results    []RegressionResult
	settings   *RegressionSettings
	createdRun *RegressionRun
	runInFlt   bool

	archiveErr error
}

func (f *fakeStore) InsertGolden(_ context.Context, _ string, in CaptureGoldenInput) (*GoldenExample, error) {
	f.goldenIn = append(f.goldenIn, in)
	requestID := in.RequestID
	g := GoldenExample{ID: "gx-new", SurfaceKind: in.SurfaceKind, Brief: in.Brief, ModelID: in.ModelID, RequestID: &requestID}
	f.golden = append(f.golden, g)
	return &g, nil
}

func (f *fakeStore) ListGolden(_ context.Context, _, surfaceKind string, _ int) ([]GoldenExample, error) {
	if surfaceKind == "" {
		return f.golden, nil
	}
	out := []GoldenExample{}
	for _, g := range f.golden {
		if g.SurfaceKind == surfaceKind {
			out = append(out, g)
		}
	}
	return out, nil
}

func (f *fakeStore) CountGolden(_ context.Context, _ string) (int, error) { return f.goldenN, nil }

func (f *fakeStore) ArchiveGolden(_ context.Context, _, _ string) error { return f.archiveErr }

func (f *fakeStore) CreateRun(_ context.Context, _ string, in TriggerRunInput) (*RegressionRun, error) {
	if f.runInFlt {
		return nil, ErrRunInFlight
	}
	if f.goldenN == 0 {
		return nil, ErrNoGoldenExamples
	}
	settings := DefaultSettings()
	if f.settings != nil {
		settings = *f.settings
	}
	run := &RegressionRun{ID: "run-new", ModelVersionTag: in.ModelVersionTag, Status: RunStatusPending, TotalExamples: f.goldenN, WarnThreshold: settings.WarnThreshold}
	f.createdRun = run
	return run, nil
}

func (f *fakeStore) ClaimRun(context.Context, string, time.Duration) (*ClaimedRegressionRun, error) {
	return nil, ErrNotFound
}

func (f *fakeStore) RenewRunLease(context.Context, string, string, string, int, time.Duration) (*RegressionRun, error) {
	return nil, ErrLeaseLost
}

func (f *fakeStore) RetryRun(context.Context, string, string, string, int, time.Time, RunFailure) (*RegressionRun, error) {
	return nil, ErrLeaseLost
}

func (f *fakeStore) FinalizeRun(context.Context, string, string, string, int) (*RegressionRun, error) {
	return nil, ErrLeaseLost
}

func (f *fakeStore) FailRun(context.Context, string, string, string, int, RunFailure) (*RegressionRun, error) {
	return nil, ErrLeaseLost
}

func (f *fakeStore) RequeueStaleRuns(context.Context, time.Time, int) (int, error) {
	return 0, nil
}

func (f *fakeStore) UpsertResult(context.Context, string, string, string, int, UpsertRegressionResultInput) (*RegressionResult, error) {
	return nil, ErrLeaseLost
}

func (f *fakeStore) ListRuns(_ context.Context, _ string, _ int) ([]RegressionRun, error) {
	return f.runs, nil
}

func (f *fakeStore) LatestRun(_ context.Context, _ string) (*RegressionRun, error) {
	if len(f.runs) == 0 {
		return nil, ErrNotFound
	}
	r := f.runs[0]
	return &r, nil
}

func (f *fakeStore) GetRun(_ context.Context, _, id string) (*RegressionRun, error) {
	for i := range f.runs {
		if f.runs[i].ID == id {
			r := f.runs[i]
			return &r, nil
		}
	}
	return nil, ErrNotFound
}

func (f *fakeStore) ListResults(_ context.Context, _, _ string) ([]RegressionResult, error) {
	return f.results, nil
}

func (f *fakeStore) GetSettings(_ context.Context, _ string) (RegressionSettings, error) {
	if f.settings != nil {
		return *f.settings, nil
	}
	return DefaultSettings(), nil
}

func (f *fakeStore) PutSettings(_ context.Context, _ string, s RegressionSettings) (RegressionSettings, error) {
	f.settings = &s
	return s, nil
}

// ----- helpers ------------------------------------------------------------

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

func TestRegressionEvidenceNoStoreWrapsSuccessAndDenial(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusOK, http.StatusForbidden} {
		status := status
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			recorder := httptest.NewRecorder()
			handler := regressionEvidenceNoStore(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			handler.ServeHTTP(
				recorder,
				httptest.NewRequest(http.MethodGet, "/api/v1/ai-regression/runs", nil),
			)
			if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
			if recorder.Code != status {
				t.Fatalf("status = %d, want %d", recorder.Code, status)
			}
		})
	}
}

// ----- CaptureGolden ------------------------------------------------------

const captureRequestID = "60d2ca3e-9707-488a-84da-0a0705d54157"

func TestCaptureGolden_ValidationErrors(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	cases := []struct {
		name string
		body string
	}{
		{"empty brief", `{"surface_kind":"campaign_draft","brief":"","approved_output":"out","request_id":"` + captureRequestID + `"}`},
		{"empty output", `{"surface_kind":"campaign_draft","brief":"b","approved_output":"","request_id":"` + captureRequestID + `"}`},
		{"bad surface", `{"surface_kind":"nope","brief":"b","approved_output":"o","request_id":"` + captureRequestID + `"}`},
		{"brief too long", `{"surface_kind":"campaign_draft","brief":"` + strings.Repeat("x", 8001) + `","approved_output":"o","request_id":"` + captureRequestID + `"}`},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		d.CaptureGolden(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/golden-examples", tc.body, nil))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", tc.name, rec.Code)
		}
	}
}

func TestCaptureGolden_RequestIDValidation(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	for _, requestID := range []string{"", "not-a-uuid", "60D2CA3E-9707-488A-84DA-0A0705D54157"} {
		rec := httptest.NewRecorder()
		body := `{"surface_kind":"campaign_draft","brief":"brief","approved_output":"approved","request_id":"` + requestID + `"}`
		d.CaptureGolden(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/golden-examples", body, nil))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("request_id %q: status = %d, want 422: %s", requestID, rec.Code, rec.Body.String())
		}
	}
}

func TestCaptureGolden_HappyPath(t *testing.T) {
	store := &fakeStore{}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.CaptureGolden(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/golden-examples",
		`{"surface_kind":"campaign_draft","brief":"re-engage lapsed","approved_output":"Hey there, miss you!","request_id":"`+captureRequestID+`"}`, nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	if len(store.goldenIn) != 1 {
		t.Fatalf("InsertGolden calls = %d, want 1", len(store.goldenIn))
	}
	if store.goldenIn[0].RequestID != captureRequestID {
		t.Fatalf("request_id = %q, want %q", store.goldenIn[0].RequestID, captureRequestID)
	}
}

func TestCaptureGoldenRejectsCallerAuthoredProvenance(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	for _, field := range []string{"model_id", "approval_id", "agent_run_id", "voice_profile_version"} {
		rec := httptest.NewRecorder()
		body := `{"surface_kind":"campaign_draft","brief":"brief","approved_output":"approved","request_id":"` + captureRequestID + `","` + field + `":"forged"}`
		d.CaptureGolden(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/golden-examples", body, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("field %s: status = %d, want 400: %s", field, rec.Code, rec.Body.String())
		}
	}
}

// ----- ListGolden ---------------------------------------------------------

func TestListGolden_BadSurfaceFilter422(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.ListGolden(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/golden-examples?surface_kind=bogus", "", nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}

func TestListGolden_OK(t *testing.T) {
	store := &fakeStore{golden: []GoldenExample{{ID: "gx-1", SurfaceKind: "campaign_draft"}}}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.ListGolden(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/golden-examples", "", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := decodeBody(t, rec)
	items, _ := out["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", out)
	}
}

// ----- ArchiveGolden ------------------------------------------------------

func TestArchiveGolden_NotFound(t *testing.T) {
	d := &Deps{Store: &fakeStore{archiveErr: ErrNotFound}}
	rec := httptest.NewRecorder()
	d.ArchiveGolden(rec, tenantRequest(t, http.MethodDelete, "/api/v1/ai-regression/golden-examples/missing", "", map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestArchiveGolden_OK(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.ArchiveGolden(rec, tenantRequest(t, http.MethodDelete, "/api/v1/ai-regression/golden-examples/gx-1", "", map[string]string{"id": "gx-1"}))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

// ----- TriggerRun ---------------------------------------------------------

func triggerTestDeps(store Store) *Deps {
	return &Deps{
		Store: store,
		Runtime: VoiceRuntimeIdentity{
			Provider:            DefaultRuntimeProvider,
			ModelID:             DefaultRuntimeModelID,
			PromptPolicyVersion: DefaultRuntimePromptPolicyVersion,
		},
		ExecutionReady: true,
	}
}

func TestTriggerRun_NoGoldenExamples_422(t *testing.T) {
	d := triggerTestDeps(&fakeStore{goldenN: 0})
	rec := httptest.NewRecorder()
	d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs",
		`{"model_version_tag":"gemini-3@2026-06-15"}`, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
}

func TestTriggerRun_MissingModelTag_422(t *testing.T) {
	d := triggerTestDeps(&fakeStore{goldenN: 5})
	rec := httptest.NewRecorder()
	d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs", `{}`, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}

func TestTriggerRun_CreatesRunRow_202(t *testing.T) {
	store := &fakeStore{goldenN: 7}
	d := triggerTestDeps(store)
	rec := httptest.NewRecorder()
	d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs",
		`{"model_version_tag":"gemini-3@2026-06-15"}`, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	out := decodeBody(t, rec)
	if out["run_id"] != "run-new" {
		t.Fatalf("run_id = %v", out)
	}
	if store.createdRun == nil || store.createdRun.TotalExamples != 7 {
		t.Fatalf("createdRun = %+v", store.createdRun)
	}
}

func TestTriggerRun_InFlight_409(t *testing.T) {
	d := triggerTestDeps(&fakeStore{goldenN: 5, runInFlt: true})
	rec := httptest.NewRecorder()
	d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs",
		`{"model_version_tag":"gemini-3@2026-06-15"}`, nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestTriggerRunFailsClosedWithoutConfiguredExecutor(t *testing.T) {
	d := &Deps{Store: &fakeStore{goldenN: 1}}
	rec := httptest.NewRecorder()
	d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs",
		`{"model_version_tag":"candidate-2026-08"}`, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
}

func TestTriggerRunRejectsCallerAuthoredRuntimeFields(t *testing.T) {
	d := triggerTestDeps(&fakeStore{goldenN: 1})
	for _, body := range []string{
		`{"model_version_tag":"candidate","model_id":"forged"}`,
		`{"model_version_tag":"candidate","prompt_version_tag":"forged"}`,
		`{"model_version_tag":"candidate","warn_threshold":1}`,
	} {
		rec := httptest.NewRecorder()
		d.TriggerRun(rec, tenantRequest(t, http.MethodPost, "/api/v1/ai-regression/runs", body, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400: %s", body, rec.Code, rec.Body.String())
		}
	}
}

// ----- GetLatestRun -------------------------------------------------------

func TestGetLatestRun_NoRuns_ReturnsNull(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.GetLatestRun(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/runs/latest", "", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := decodeBody(t, rec)
	if v, ok := out["run"]; !ok || v != nil {
		t.Fatalf("expected {run:null}, got %v", out)
	}
}

func TestGetLatestRun_HasRun(t *testing.T) {
	d := &Deps{Store: &fakeStore{runs: []RegressionRun{{ID: "run-1", Status: RunStatusCompleted}}}}
	rec := httptest.NewRecorder()
	d.GetLatestRun(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/runs/latest", "", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := decodeBody(t, rec)
	if out["run"] == nil {
		t.Fatalf("expected a run, got %v", out)
	}
}

// ----- GetRunResults ------------------------------------------------------

func TestGetRunResults_404OnMissingRun(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.GetRunResults(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/runs/missing/results", "", map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// ----- settings -----------------------------------------------------------

func TestSettings_DefaultsApply(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.GetSettings(rec, tenantRequest(t, http.MethodGet, "/api/v1/ai-regression/settings", "", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := decodeBody(t, rec)
	if out["warn_threshold"] != 60.0 {
		t.Fatalf("warn_threshold = %v, want 60", out["warn_threshold"])
	}
	if out["hard_gate_enabled"] != false {
		t.Fatalf("hard_gate_enabled = %v, want false", out["hard_gate_enabled"])
	}
	if out["min_examples_for_gate"] != float64(5) {
		t.Fatalf("min_examples_for_gate = %v, want 5", out["min_examples_for_gate"])
	}
}

func TestSettings_ThresholdValidation422(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	for _, body := range []string{
		`{"warn_threshold":60,"hard_gate_enabled":true,"hard_gate_threshold":150,"min_examples_for_gate":5}`,
		`{"warn_threshold":-1,"hard_gate_enabled":false,"hard_gate_threshold":70,"min_examples_for_gate":5}`,
		`{"warn_threshold":60,"hard_gate_enabled":false,"hard_gate_threshold":70}`,
		`{"warn_threshold":60,"hard_gate_enabled":false,"hard_gate_threshold":70,"min_examples_for_gate":0}`,
		`{"warn_threshold":60,"hard_gate_enabled":false,"hard_gate_threshold":70,"min_examples_for_gate":2147483648}`,
	} {
		rec := httptest.NewRecorder()
		d.UpdateSettings(rec, tenantRequest(t, http.MethodPut, "/api/v1/ai-regression/settings", body, nil))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %q: status = %d, want 422", body, rec.Code)
		}
	}
}

func TestSettings_MinExamplesMaxInt32Accepted(t *testing.T) {
	store := &fakeStore{}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.UpdateSettings(rec, tenantRequest(t, http.MethodPut, "/api/v1/ai-regression/settings",
		`{"warn_threshold":60,"hard_gate_enabled":false,"hard_gate_threshold":70,"min_examples_for_gate":2147483647}`, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.settings == nil || store.settings.MinExamplesForGate != 2147483647 {
		t.Fatalf("expected max int32 min_examples_for_gate, got %+v", store.settings)
	}
}

func TestSettings_UpdateOK(t *testing.T) {
	store := &fakeStore{}
	d := &Deps{Store: store}
	rec := httptest.NewRecorder()
	d.UpdateSettings(rec, tenantRequest(t, http.MethodPut, "/api/v1/ai-regression/settings",
		`{"warn_threshold":65,"hard_gate_enabled":true,"hard_gate_threshold":80,"min_examples_for_gate":5}`, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if store.settings == nil || store.settings.MinExamplesForGate != DefaultMinExamplesForGate {
		t.Fatalf("expected min_examples_for_gate %d, got %+v", DefaultMinExamplesForGate, store.settings)
	}
}

// ----- require tenant -----------------------------------------------------

func TestHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	for name, h := range map[string]http.HandlerFunc{
		"capture": d.CaptureGolden, "list": d.ListGolden, "archive": d.ArchiveGolden,
		"trigger": d.TriggerRun, "runs": d.ListRuns, "latest": d.GetLatestRun,
		"getRun": d.GetRun, "results": d.GetRunResults,
		"getSettings": d.GetSettings, "putSettings": d.UpdateSettings,
	} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ai-regression/x", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401 without tenant", name, rec.Code)
		}
	}
}

// ----- ComputeGate (pure table test) --------------------------------------

func TestComputeGate(t *testing.T) {
	advisoryDefault := DefaultSettings() // hard gate OFF
	gateOn := RegressionSettings{WarnThreshold: 60, HardGateEnabled: true, HardGateThreshold: 70, MinExamplesForGate: 5}

	cases := []struct {
		name string
		in   GateInput
		want string
	}{
		{"no scored examples → advisory", GateInput{MeanScore: 0, ScoredExamples: 0, Settings: gateOn}, GateAdvisory},
		{"partial evidence never passes", GateInput{MeanScore: 100, ScoredExamples: 9, TotalExamples: 10, Settings: gateOn}, GateAdvisory},
		{"partial advisory evidence never passes", GateInput{MeanScore: 100, ScoredExamples: 9, TotalExamples: 10, Settings: advisoryDefault}, GateAdvisory},
		{"over-counted evidence never passes", GateInput{MeanScore: 100, ScoredExamples: 11, TotalExamples: 10, Settings: gateOn}, GateAdvisory},
		{"non-finite mean never passes", GateInput{MeanScore: math.NaN(), ScoredExamples: 10, TotalExamples: 10, Settings: gateOn}, GateAdvisory},
		{"invalid threshold never passes", GateInput{MeanScore: 100, ScoredExamples: 10, TotalExamples: 10, Settings: RegressionSettings{WarnThreshold: math.Inf(1), HardGateThreshold: 70}}, GateAdvisory},
		{"advisory mode, above warn → pass", GateInput{MeanScore: 80, ScoredExamples: 10, Settings: advisoryDefault}, GatePass},
		{"advisory mode, below warn → advisory", GateInput{MeanScore: 55, ScoredExamples: 10, Settings: advisoryDefault}, GateAdvisory},
		{"advisory mode, exactly warn → pass", GateInput{MeanScore: 60, ScoredExamples: 10, Settings: advisoryDefault}, GatePass},
		{"gate on, enough examples, below hard → fail", GateInput{MeanScore: 65, ScoredExamples: 6, Settings: gateOn}, GateFail},
		{"gate on, enough examples, at/above hard → pass", GateInput{MeanScore: 72, ScoredExamples: 6, Settings: gateOn}, GatePass},
		{"gate on, exactly hard → pass", GateInput{MeanScore: 70, ScoredExamples: 5, Settings: gateOn}, GatePass},
		{"gate on but N<5 → degrades to advisory (below warn)", GateInput{MeanScore: 50, ScoredExamples: 4, Settings: gateOn}, GateAdvisory},
		{"gate on but N<5, above warn → still advisory", GateInput{MeanScore: 80, ScoredExamples: 4, Settings: gateOn}, GateAdvisory},
		{"gate on, exactly minN below hard → fail", GateInput{MeanScore: 50, ScoredExamples: 5, Settings: gateOn}, GateFail},
	}
	for _, tc := range cases {
		if got := ComputeGate(tc.in); got != tc.want {
			t.Errorf("%s: ComputeGate = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// ----- golden adapter surface mapping (unit) ------------------------------

func TestSurfaceKindForResource(t *testing.T) {
	cases := map[string]string{
		string(approvals.ResourceCampaign):       SurfaceCampaignDraft,
		string(approvals.ResourceSequence):       SurfaceSequenceDraft,
		string(approvals.ResourceAutomationSend): "",
		"unknown":                                "",
	}
	for in, want := range cases {
		if got := SurfaceKindForResource(in); got != want {
			t.Errorf("SurfaceKindForResource(%q) = %q, want %q", in, got, want)
		}
	}
}

type fakeResolver struct {
	res ResolvedResource
	ok  bool
}

func (f fakeResolver) Resolve(_ context.Context, _, _, _ string) (ResolvedResource, bool, error) {
	return f.res, f.ok, nil
}

func TestGoldenAdapter_CaptureGolden(t *testing.T) {
	t.Run("campaign approval captures a golden example", func(t *testing.T) {
		store := &fakeStore{}
		a := &GoldenAdapter{
			Store:    store,
			Resolver: fakeResolver{res: ResolvedResource{Brief: "subject", ApprovedOutput: "<p>Hi <b>there</b></p>", ModelID: "gemini-3"}, ok: true},
		}
		err := a.CaptureGolden(context.Background(), &approvals.Approval{
			ID: "ap-1", TenantID: "t1", ResourceType: string(approvals.ResourceCampaign), ResourceID: "c1",
		})
		if err != nil {
			t.Fatalf("CaptureGolden err = %v", err)
		}
		if len(store.goldenIn) != 1 {
			t.Fatalf("InsertGolden calls = %d, want 1", len(store.goldenIn))
		}
		got := store.goldenIn[0]
		if got.SurfaceKind != SurfaceCampaignDraft || got.ApprovedOutput != "Hi there" || got.ApprovalID != "ap-1" {
			t.Fatalf("captured input = %+v (output should be HTML-stripped)", got)
		}
	})

	t.Run("automation_send is skipped (not a capturable surface)", func(t *testing.T) {
		store := &fakeStore{}
		a := &GoldenAdapter{Store: store, Resolver: fakeResolver{res: ResolvedResource{Brief: "b", ApprovedOutput: "o"}, ok: true}}
		if err := a.CaptureGolden(context.Background(), &approvals.Approval{
			ID: "ap-2", TenantID: "t1", ResourceType: string(approvals.ResourceAutomationSend), ResourceID: "x",
		}); err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(store.goldenIn) != 0 {
			t.Fatalf("expected no capture for automation_send, got %d", len(store.goldenIn))
		}
	})

	t.Run("empty resolved content is not persisted", func(t *testing.T) {
		store := &fakeStore{}
		a := &GoldenAdapter{Store: store, Resolver: fakeResolver{res: ResolvedResource{Brief: "  ", ApprovedOutput: "<p></p>"}, ok: true}}
		if err := a.CaptureGolden(context.Background(), &approvals.Approval{
			ID: "ap-3", TenantID: "t1", ResourceType: string(approvals.ResourceCampaign), ResourceID: "c2",
		}); err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(store.goldenIn) != 0 {
			t.Fatalf("expected no capture for empty content, got %d", len(store.goldenIn))
		}
	})
}
