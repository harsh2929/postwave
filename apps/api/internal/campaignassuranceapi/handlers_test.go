// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeAssuranceService struct {
	mu sync.Mutex

	startCommand StartRunCommand
	startRun     *campaignassurance.Run
	startSources []string
	startErr     error
	startCalls   int

	latestResult *RunDetail
	latestErr    error
	latestCalls  int

	detailResult *RunDetail
	detailErr    error
	detailCalls  int

	evidenceResult *EvidencePage
	evidenceErr    error
	evidenceCalls  int
	evidenceOffset int
	evidenceLimit  int

	progressResult *ProgressSnapshot
	progressErr    error
	progressCalls  int

	appealCommand AppealCommand
	appealResult  *campaignassurance.Override
	appealErr     error
	appealCalls   int

	cancelResult *campaignassurance.Run
	cancelErr    error
	cancelCalls  int
}

type fakeFindingRemediator struct {
	mu     sync.Mutex
	tenant string
	input  campaignartifact.ApplyAssuranceFindingInput
	result *campaignartifact.ApplyAssuranceFindingResult
	err    error
	calls  int
}

type fakeSnapshotPreparer struct {
	mu      sync.Mutex
	command PrepareSnapshotCommand
	result  PreparedSnapshot
	err     error
	calls   int
}

func (f *fakeSnapshotPreparer) PrepareAssuranceSnapshot(
	_ context.Context,
	command PrepareSnapshotCommand,
) (PreparedSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.command = command
	return f.result, f.err
}

func (f *fakeFindingRemediator) ApplyAssuranceFinding(
	_ context.Context,
	tenantID string,
	input campaignartifact.ApplyAssuranceFindingInput,
) (*campaignartifact.ApplyAssuranceFindingResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.tenant = tenantID
	f.input = input
	return f.result, f.err
}

func (f *fakeAssuranceService) StartRun(_ context.Context, command StartRunCommand) (*campaignassurance.Run, []string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startCalls++
	f.startCommand = command
	return f.startRun, append([]string(nil), f.startSources...), f.startErr
}

func (f *fakeAssuranceService) Latest(context.Context, string, string) (*RunDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latestCalls++
	return f.latestResult, f.latestErr
}

func (f *fakeAssuranceService) Detail(context.Context, string, string, string) (*RunDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detailCalls++
	return f.detailResult, f.detailErr
}

func (f *fakeAssuranceService) Evidence(_ context.Context, _, _, _ string, offset, limit int) (*EvidencePage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.evidenceCalls++
	f.evidenceOffset = offset
	f.evidenceLimit = limit
	return f.evidenceResult, f.evidenceErr
}

func (f *fakeAssuranceService) Progress(context.Context, string, string, string) (*ProgressSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progressCalls++
	return f.progressResult, f.progressErr
}

func (f *fakeAssuranceService) Appeal(_ context.Context, command AppealCommand) (*campaignassurance.Override, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.appealCalls++
	f.appealCommand = command
	return f.appealResult, f.appealErr
}

func (f *fakeAssuranceService) Cancel(context.Context, string, string, string) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelCalls++
	return f.cancelResult, f.cancelErr
}

func mountedAssuranceRouter(service AssuranceService) http.Handler {
	return mountedAssuranceRouterWith(service, nil)
}

// The shared helpers wire a permissive meter so these tests stay about the
// behaviour they name. Metering itself is covered in entitlement_test.go,
// including the case where no meter is configured at all.
func mountedAssuranceRouterWith(service AssuranceService, remediator FindingRemediator) http.Handler {
	router := chi.NewRouter()
	Mount(router, &Deps{
		Service: service, Remediator: remediator, Entitlements: &fakePlanLimiter{},
	})
	return router
}

func mountedAssuranceRouterWithPreparer(
	service AssuranceService,
	preparer SnapshotPreparer,
) http.Handler {
	router := chi.NewRouter()
	Mount(router, &Deps{
		Service: service, Preparer: preparer, Entitlements: &fakePlanLimiter{},
	})
	return router
}

func authenticatedRequest(method, path, body, role string) *http.Request {
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: testTenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: testActorID, TenantID: testTenantID, Role: role,
	})
	return request.WithContext(ctx)
}

func validCreateBody() string {
	return `{"profile":"full","content_revision_id":"` + testRevisionID +
		`","send_plan_id":"` + testPlanID + `","request_id":"` + testRequestID + `"}`
}

func TestCreateRunPublicContractDerivesIdentityAndDisclosesPrediction(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun:     &run,
		startSources: []string{campaignassurance.SourceDeterministic, campaignassurance.SourceModeled},
	}
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", validCreateBody(), "editor")
	request.Header.Set(idempotency.HeaderName, "create-assurance-full")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouter(service).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if service.startCalls != 1 || service.startCommand != (StartRunCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		SendPlanID: testPlanID, RequestID: testRequestID,
		Profile: campaignassurance.ProfileFull, ActorID: testActorID,
	}) {
		t.Fatalf("start command=%+v calls=%d", service.startCommand, service.startCalls)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"name":"Predicted Agent Comprehension"`) ||
		!strings.Contains(body, `"class":"deterministic","present":true`) ||
		!strings.Contains(body, `"class":"modeled","present":true`) ||
		!strings.Contains(body, "does not report how Gemini") {
		t.Fatalf("missing honest measurement disclosure: %s", body)
	}
	wantLocation := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID
	if recorder.Header().Get("Location") != wantLocation || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers=%v", recorder.Header())
	}
}

func TestCreateRunCanPrepareTheExactCurrentSnapshotServerSide(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun: &run, startSources: []string{campaignassurance.SourceDeterministic},
	}
	preparer := &fakeSnapshotPreparer{result: PreparedSnapshot{
		ContentRevisionID: testRevisionID, SendPlanID: testPlanID,
	}}
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs",
		`{"profile":"full","request_id":"`+testRequestID+`"}`, "editor")
	request.Header.Set(idempotency.HeaderName, "prepare-current-assurance")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithPreparer(service, preparer).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted || preparer.calls != 1 || service.startCalls != 1 {
		t.Fatalf("status=%d prepare=%d start=%d body=%s", recorder.Code, preparer.calls, service.startCalls, recorder.Body.String())
	}
	wantPrepare := PrepareSnapshotCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		RequestID: testRequestID, ActorID: testActorID,
	}
	if preparer.command != wantPrepare || service.startCommand.ContentRevisionID != testRevisionID ||
		service.startCommand.SendPlanID != testPlanID {
		t.Fatalf("prepare=%+v start=%+v", preparer.command, service.startCommand)
	}
}

func TestCreateRunCanPrepareOneCallerSelectedImmutableRevision(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{startRun: &run}
	preparer := &fakeSnapshotPreparer{result: PreparedSnapshot{
		ContentRevisionID: testRevisionID, SendPlanID: testPlanID,
	}}
	body := `{"profile":"fast","content_revision_id":"` + testRevisionID +
		`","request_id":"` + testRequestID + `"}`
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", body, "editor")
	request.Header.Set(idempotency.HeaderName, "prepare-selected-revision")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithPreparer(service, preparer).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted ||
		preparer.command.ContentRevisionID != testRevisionID ||
		service.startCommand.Profile != campaignassurance.ProfileFast {
		t.Fatalf("status=%d prepare=%+v start=%+v body=%s", recorder.Code, preparer.command, service.startCommand, recorder.Body.String())
	}
}

func TestCreateRunSeedRequestFailsClosedBeforePreparationOrRun(t *testing.T) {
	service := &fakeAssuranceService{}
	preparer := &fakeSnapshotPreparer{}
	body := `{"profile":"full","request_id":"` + testRequestID +
		`","include_seed_test":true,"observed_surfaces":["gmail.web.inbox"]}`
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", body, "editor")
	request.Header.Set(idempotency.HeaderName, "seed-observation-unavailable")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithPreparer(service, preparer).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable || preparer.calls != 0 || service.startCalls != 0 {
		t.Fatalf("status=%d prepare=%d start=%d body=%s", recorder.Code, preparer.calls, service.startCalls, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"controlled_observation_unavailable"`) ||
		!strings.Contains(recorder.Body.String(), `"retryable":false`) ||
		!strings.Contains(recorder.Body.String(), `"source_class":"controlled_observation"`) {
		t.Fatalf("response overclaimed or obscured capability: %s", recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
}

func TestCreateRunObservedSurfacesRequireSeedAndStableUniqueIdentifiers(t *testing.T) {
	tests := []string{
		`{"profile":"full","request_id":"` + testRequestID + `","observed_surfaces":["gmail.web.inbox"]}`,
		`{"profile":"full","request_id":"` + testRequestID + `","include_seed_test":true,"observed_surfaces":["gmail web"]}`,
		`{"profile":"full","request_id":"` + testRequestID + `","include_seed_test":true,"observed_surfaces":["gmail.web","gmail.web"]}`,
	}
	for _, body := range tests {
		service := &fakeAssuranceService{}
		request := authenticatedRequest(http.MethodPost,
			"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", body, "editor")
		request.Header.Set(idempotency.HeaderName, "invalid-seed-surface")
		recorder := httptest.NewRecorder()
		mountedAssuranceRouter(service).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnprocessableEntity || service.startCalls != 0 ||
			!strings.Contains(recorder.Body.String(), `"code":"invalid_observed_surfaces"`) {
			t.Fatalf("status=%d start=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
		}
	}
}

func TestCreateRunRejectsPartialOrUnavailableServerPreparation(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		preparer SnapshotPreparer
		want     int
	}{
		{
			name:     "plan without revision",
			body:     `{"profile":"full","send_plan_id":"` + testPlanID + `","request_id":"` + testRequestID + `"}`,
			preparer: &fakeSnapshotPreparer{}, want: http.StatusUnprocessableEntity,
		},
		{
			name: "preparer unavailable",
			body: `{"profile":"full","request_id":"` + testRequestID + `"}`,
			want: http.StatusServiceUnavailable,
		},
		{
			name:     "unsupported snapshot",
			body:     `{"profile":"full","request_id":"` + testRequestID + `"}`,
			preparer: &fakeSnapshotPreparer{err: ErrSnapshotUnsupported}, want: http.StatusUnprocessableEntity,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeAssuranceService{}
			request := authenticatedRequest(http.MethodPost,
				"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", test.body, "editor")
			request.Header.Set(idempotency.HeaderName, "prepare-rejected")
			recorder := httptest.NewRecorder()
			mountedAssuranceRouterWithPreparer(service, test.preparer).ServeHTTP(recorder, request)
			if recorder.Code != test.want || service.startCalls != 0 {
				t.Fatalf("status=%d start=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
			}
		})
	}
}

func TestCreateRunSupportsUserBoundAPIKeyWithoutTrustingRequestRole(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{startRun: &run, startSources: []string{campaignassurance.SourceDeterministic}}
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", validCreateBody(), "")
	request.Header.Set(idempotency.HeaderName, "api-key-assurance")
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
	request = request.WithContext(ctx)
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || service.startCommand.ActorID != testActorID {
		t.Fatalf("status=%d command=%+v body=%s", recorder.Code, service.startCommand, recorder.Body.String())
	}
}

func TestCreateRunRejectsCallerSuiteInjectionBeforeService(t *testing.T) {
	service := &fakeAssuranceService{}
	body := strings.TrimSuffix(validCreateBody(), "}") + `,"prompt_suite_version":"attacker-latest"}`
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", body, "owner")
	request.Header.Set(idempotency.HeaderName, "inject-suite")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouter(service).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || service.startCalls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
	}
}

func TestCreateRunRequiresExactlyOneBoundedIdempotencyKey(t *testing.T) {
	for _, test := range []struct {
		name   string
		values []string
	}{
		{name: "missing"},
		{name: "duplicates", values: []string{"first", "second"}},
		{name: "control", values: []string{"first\nsecond"}},
		{name: "too long", values: []string{strings.Repeat("a", idempotency.MaxKeyLength+1)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeAssuranceService{}
			request := authenticatedRequest(http.MethodPost,
				"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", validCreateBody(), "owner")
			request.Header[idempotency.HeaderName] = test.values
			recorder := httptest.NewRecorder()
			mountedAssuranceRouter(service).ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest || service.startCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
			}
		})
	}
}

func TestCreateRunEnforcesSmallBodyLimit(t *testing.T) {
	service := &fakeAssuranceService{}
	body := `{"profile":"full","padding":"` + strings.Repeat("x", int(createRunBodyMaxBytes)) + `"}`
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", body, "owner")
	request.Header.Set(idempotency.HeaderName, "oversized")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge || service.startCalls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
	}
}

func TestApplyFindingRequiresExactDraftVersionAndReturnsNewRevisionReceipt(t *testing.T) {
	result := &campaignartifact.ApplyAssuranceFindingResult{
		Application: campaignartifact.PatchApplication{
			ID:         "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			CampaignID: testCampaignID, RunID: testRunID,
			FindingID: testFindingID, RequestID: testRequestID,
			BaseContentRevisionID:    testRevisionID,
			CreatedContentRevisionID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		},
		Revision: campaignartifact.Revision{
			ID:         "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			CampaignID: testCampaignID, RevisionNo: 2,
		},
		CampaignETag:        `"campaign-new-version"`,
		OriginatingRunState: "stale", RerunRequired: true,
	}
	remediator := &fakeFindingRemediator{result: result}
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID +
		"/findings/" + testFindingID + "/apply"
	request := authenticatedRequest(http.MethodPost, path,
		`{"request_id":"`+testRequestID+`"}`, "editor")
	request.Header.Set(idempotency.HeaderName, "apply-heading-fix")
	request.Header.Set("If-Match", `"campaign-reviewed-version"`)
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWith(nil, remediator).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated || remediator.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, remediator.calls, recorder.Body.String())
	}
	want := campaignartifact.ApplyAssuranceFindingInput{
		CampaignID: testCampaignID, RunID: testRunID, FindingID: testFindingID,
		RequestID: testRequestID, ActorID: testActorID,
		IfMatchToken: `"campaign-reviewed-version"`,
	}
	if remediator.tenant != testTenantID || remediator.input != want {
		t.Fatalf("tenant=%q input=%+v want=%+v", remediator.tenant, remediator.input, want)
	}
	location := "/api/v1/campaigns/" + testCampaignID + "/content-revisions/" + result.Revision.ID
	if recorder.Header().Get("ETag") != result.CampaignETag ||
		recorder.Header().Get("Location") != location ||
		recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers=%v", recorder.Header())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"rerun_required":true`) ||
		!strings.Contains(body, `"originating_run_state":"stale"`) ||
		!strings.Contains(body, `"class":"deterministic","present":true`) {
		t.Fatalf("incomplete apply receipt: %s", body)
	}
}

func TestApplyFindingRejectsUnsafePreconditionsAndBodyInjection(t *testing.T) {
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID +
		"/findings/" + testFindingID + "/apply"
	validBody := `{"request_id":"` + testRequestID + `"}`
	tests := []struct {
		name       string
		ifMatch    []string
		body       string
		idempotent bool
		want       int
	}{
		{name: "missing If-Match", body: validBody, idempotent: true, want: http.StatusPreconditionRequired},
		{name: "wildcard", ifMatch: []string{"*"}, body: validBody, idempotent: true, want: http.StatusPreconditionFailed},
		{name: "weak", ifMatch: []string{`W/"version"`}, body: validBody, idempotent: true, want: http.StatusPreconditionFailed},
		{name: "multiple", ifMatch: []string{`"one"`, `"two"`}, body: validBody, idempotent: true, want: http.StatusPreconditionFailed},
		{name: "body patch injection", ifMatch: []string{`"version"`}, body: strings.TrimSuffix(validBody, "}") + `,"typed_patch":{"operation":"replace_html"}}`, idempotent: true, want: http.StatusBadRequest},
		{name: "missing idempotency", ifMatch: []string{`"version"`}, body: validBody, want: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			remediator := &fakeFindingRemediator{}
			request := authenticatedRequest(http.MethodPost, path, test.body, "editor")
			request.Header["If-Match"] = test.ifMatch
			if test.idempotent {
				request.Header.Set(idempotency.HeaderName, "apply-rejected")
			}
			recorder := httptest.NewRecorder()
			mountedAssuranceRouterWith(nil, remediator).ServeHTTP(recorder, request)
			if recorder.Code != test.want || remediator.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, remediator.calls, recorder.Body.String())
			}
		})
	}
}

func TestAppealIsFindingScopedAndActorComesOnlyFromContext(t *testing.T) {
	override := campaignassurance.Override{
		ID: testOverrideID, CampaignID: testCampaignID, RunID: testRunID,
		FindingID: testFindingID, RequestID: testRequestID, ActorID: testActorID,
		ActorRole: "admin", Decision: "allow_send", Reason: "approved known exception",
	}
	service := &fakeAssuranceService{appealResult: &override}
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID +
		"/findings/" + testFindingID + "/appeals"
	body := `{"request_id":"` + testRequestID + `","decision":"allow_send","reason":"approved known exception"}`
	request := authenticatedRequest(http.MethodPost, path, body, "admin")
	request.Header.Set(idempotency.HeaderName, "appeal-one-finding")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouter(service).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || service.appealCalls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.appealCalls, recorder.Body.String())
	}
	want := AppealCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
		FindingID: testFindingID, RequestID: testRequestID, ActorID: testActorID,
		Decision: "allow_send", Reason: "approved known exception",
	}
	if service.appealCommand != want {
		t.Fatalf("appeal command=%+v want=%+v", service.appealCommand, want)
	}
	if !strings.Contains(recorder.Body.String(), "Predicted Agent Comprehension") {
		t.Fatalf("missing measurement name: %s", recorder.Body.String())
	}
}

func TestAppealRejectsActorOrFindingInjectionAndEditorAuthority(t *testing.T) {
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID +
		"/findings/" + testFindingID + "/overrides"
	valid := `{"request_id":"` + testRequestID + `","decision":"allow_send","reason":"approved known exception"}`
	tests := []struct {
		name       string
		role       string
		body       string
		wantStatus int
	}{
		{name: "actor injection", role: "admin", body: strings.TrimSuffix(valid, "}") + `,"actor_id":"` + testActorID + `"}`, wantStatus: http.StatusBadRequest},
		{name: "role injection", role: "admin", body: strings.TrimSuffix(valid, "}") + `,"actor_role":"owner"}`, wantStatus: http.StatusBadRequest},
		{name: "finding injection", role: "admin", body: strings.TrimSuffix(valid, "}") + `,"finding_id":"` + testFindingID + `"}`, wantStatus: http.StatusBadRequest},
		{name: "editor cannot govern send", role: "editor", body: valid, wantStatus: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeAssuranceService{}
			request := authenticatedRequest(http.MethodPost, path, test.body, test.role)
			request.Header.Set(idempotency.HeaderName, "appeal-rejected")
			recorder := httptest.NewRecorder()
			mountedAssuranceRouter(service).ServeHTTP(recorder, request)
			if recorder.Code != test.wantStatus || service.appealCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.appealCalls, recorder.Body.String())
			}
		})
	}
}

func TestReadNotFoundHasNoCrossCampaignOracle(t *testing.T) {
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID
	bodies := make([]string, 0, 2)
	for _, domainErr := range []error{campaignassurance.ErrNotFound, errors.Join(campaignassurance.ErrNotFound, errors.New("different campaign"))} {
		service := &fakeAssuranceService{detailErr: domainErr}
		request := authenticatedRequest(http.MethodGet, path, "", "viewer")
		recorder := httptest.NewRecorder()
		mountedAssuranceRouter(service).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		bodies = append(bodies, recorder.Body.String())
	}
	if bodies[0] != bodies[1] || strings.Contains(bodies[0], "campaign") && strings.Contains(bodies[0], "different campaign") {
		t.Fatalf("not-found oracle differed: %#v", bodies)
	}
}

func TestEventsEndpointReportsSnapshotInsteadOfFabricatedHistory(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{progressResult: &ProgressSnapshot{
		RunID: testRunID, State: run.State, GateDecision: run.GateDecision,
		RequiredExtractions: run.RequiredExtractionCount, EventHistoryAvailable: false,
		EventHistoryExplanation: "durable event history is not available; this is the current authoritative run snapshot",
		SourceClasses:           []string{campaignassurance.SourceDeterministic},
	}}
	request := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs/"+testRunID+"/events", "", "viewer")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || service.progressCalls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.progressCalls, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"event_history_available":false`) ||
		!strings.Contains(body, "durable event history is not available") ||
		!strings.Contains(body, "Predicted Agent Comprehension") {
		t.Fatalf("events response overclaimed history: %s", body)
	}
}

func TestManifestEndpointReturnsExactReceiptWithSourceDisclosure(t *testing.T) {
	run := testRun()
	detail := &RunDetail{
		Run: run, Manifest: *testManifest(run),
		SourceClasses: []string{campaignassurance.SourceDeterministic, campaignassurance.SourceModeled},
	}
	service := &fakeAssuranceService{detailResult: detail}
	request := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs/"+testRunID+"/manifest", "", "viewer")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || service.detailCalls != 1 ||
		!strings.Contains(recorder.Body.String(), `"configuration_id":"deterministic.preflight"`) ||
		!strings.Contains(recorder.Body.String(), `"class":"modeled","present":true`) {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.detailCalls, recorder.Body.String())
	}
}

func TestEvidencePaginationIsStrictAndBounded(t *testing.T) {
	service := &fakeAssuranceService{evidenceResult: &EvidencePage{
		SourceClasses: []string{campaignassurance.SourceDeterministic},
	}}
	base := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID + "/evidence"
	valid := authenticatedRequest(http.MethodGet, base+"?offset=20&limit=50", "", "viewer")
	validRecorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(validRecorder, valid)
	if validRecorder.Code != http.StatusOK || service.evidenceOffset != 20 || service.evidenceLimit != 50 {
		t.Fatalf("valid status=%d offset=%d limit=%d body=%s", validRecorder.Code, service.evidenceOffset, service.evidenceLimit, validRecorder.Body.String())
	}

	invalidService := &fakeAssuranceService{}
	invalid := authenticatedRequest(http.MethodGet, base+"?limit=201", "", "viewer")
	invalidRecorder := httptest.NewRecorder()
	mountedAssuranceRouter(invalidService).ServeHTTP(invalidRecorder, invalid)
	if invalidRecorder.Code != http.StatusBadRequest || invalidService.evidenceCalls != 0 {
		t.Fatalf("invalid status=%d calls=%d body=%s", invalidRecorder.Code, invalidService.evidenceCalls, invalidRecorder.Body.String())
	}
}

func TestCancelAllowsEmptyBodyAndRequiresAuthenticatedTenantBoundActor(t *testing.T) {
	run := testRun()
	run.State = campaignassurance.StateCancelled
	service := &fakeAssuranceService{cancelResult: &run}
	path := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID + "/cancel"
	request := authenticatedRequest(http.MethodPost, path, "", "editor")
	request.Header.Set(idempotency.HeaderName, "cancel-run")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || service.cancelCalls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.cancelCalls, recorder.Body.String())
	}

	mismatchService := &fakeAssuranceService{}
	mismatch := authenticatedRequest(http.MethodPost, path, "", "editor")
	mismatch.Header.Set(idempotency.HeaderName, "cancel-mismatch")
	ctx := middleware.WithUser(mismatch.Context(), &middleware.User{
		ID: testActorID, TenantID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Role: "editor",
	})
	mismatch = mismatch.WithContext(ctx)
	mismatchRecorder := httptest.NewRecorder()
	mountedAssuranceRouter(mismatchService).ServeHTTP(mismatchRecorder, mismatch)
	if mismatchRecorder.Code != http.StatusUnauthorized || mismatchService.cancelCalls != 0 {
		t.Fatalf("mismatch status=%d calls=%d body=%s", mismatchRecorder.Code, mismatchService.cancelCalls, mismatchRecorder.Body.String())
	}
}

func TestAssuranceRoutesRejectWrongMethods(t *testing.T) {
	service := &fakeAssuranceService{}
	request := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", "", "viewer")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed || service.startCalls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.startCalls, recorder.Body.String())
	}
}

func TestSuccessEnvelopeIsValidJSON(t *testing.T) {
	run := testRun()
	detail := &RunDetail{Run: run, Manifest: *testManifest(run), SourceClasses: []string{campaignassurance.SourceDeterministic}}
	service := &fakeAssuranceService{latestResult: detail}
	request := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/"+testCampaignID+"/assurance", "", "viewer")
	recorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(recorder, request)
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil || decoded["measurement"] == nil || decoded["data"] == nil {
		t.Fatalf("invalid envelope err=%v body=%s", err, recorder.Body.String())
	}
}

func TestDomainErrorsHaveStableSanitizedHTTPMappings(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantRetry  string
	}{
		{"not found", campaignassurance.ErrNotFound, http.StatusNotFound, "assurance_not_found", ""},
		{"invalid", campaignassurance.ErrInvalidInput, http.StatusUnprocessableEntity, "invalid_assurance_request", ""},
		{"idempotency", campaignassurance.ErrIdempotencyConflict, http.StatusConflict, "assurance_request_conflict", ""},
		{"in flight", campaignassurance.ErrRunInFlight, http.StatusConflict, "assurance_run_in_flight", ""},
		{"plan", campaignassurance.ErrPlanNotReady, http.StatusConflict, "assurance_plan_not_ready", ""},
		{"snapshot", campaignassurance.ErrSnapshotIncomplete, http.StatusConflict, "assurance_snapshot_incomplete", ""},
		{"transition", campaignassurance.ErrInvalidTransition, http.StatusConflict, "assurance_state_conflict", ""},
		{"unauthorized", campaignassurance.ErrUnauthorized, http.StatusForbidden, "assurance_forbidden", ""},
		{"override", campaignassurance.ErrOverrideNotAllowed, http.StatusConflict, "assurance_appeal_not_allowed", ""},
		{"concurrent", campaignassurance.ErrConcurrentMutation, http.StatusConflict, "assurance_concurrent_mutation", "1"},
		{"patch not found", campaignartifact.ErrNotFound, http.StatusNotFound, "assurance_not_found", ""},
		{"patch precondition", campaignartifact.ErrPreconditionFailed, http.StatusPreconditionFailed, "precondition_failed", ""},
		{"patch unavailable", campaignartifact.ErrPatchUnavailable, http.StatusConflict, "assurance_patch_unavailable", ""},
		{"patch unsupported", campaignartifact.ErrPatchUnsupported, http.StatusUnprocessableEntity, "assurance_patch_unsupported", ""},
		{"patch already applied", campaignartifact.ErrPatchAlreadyApplied, http.StatusConflict, "assurance_patch_already_applied", ""},
		{"patch stale", campaignartifact.ErrRevisionStale, http.StatusConflict, "assurance_revision_stale", ""},
		{"patch locked", campaignartifact.ErrCampaignLocked, http.StatusConflict, "campaign_edit_lease_held", ""},
		{"patch dispatched", campaignartifact.ErrCampaignDispatched, http.StatusConflict, "campaign_dispatching", ""},
		{"patch unauthorized", campaignartifact.ErrUnauthorized, http.StatusForbidden, "assurance_forbidden", ""},
		{"patch concurrent", campaignartifact.ErrConcurrentMutation, http.StatusConflict, "assurance_concurrent_mutation", "1"},
		{"patch conflict", campaignartifact.ErrIdempotencyConflict, http.StatusConflict, "assurance_request_conflict", ""},
		{"patch invalid", campaignartifact.ErrInvalidInput, http.StatusUnprocessableEntity, "invalid_assurance_patch", ""},
		{"dispatch", errors.Join(ErrDispatchUnavailable, errors.New("secret broker address")), http.StatusServiceUnavailable, "campaign_assurance_unavailable", "5"},
		{"internal", errors.New("SELECT secret FROM internal_table"), http.StatusInternalServerError, "internal_error", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			(&Deps{}).writeError(recorder, request, test.err)
			if recorder.Code != test.wantStatus || !strings.Contains(recorder.Body.String(), `"code":"`+test.wantCode+`"`) ||
				recorder.Header().Get("Retry-After") != test.wantRetry {
				t.Fatalf("status=%d retry=%q body=%s", recorder.Code, recorder.Header().Get("Retry-After"), recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), "secret") || strings.Contains(recorder.Body.String(), "internal_table") {
				t.Fatalf("internal detail leaked: %s", recorder.Body.String())
			}
		})
	}
}

// A deployment without the assurance runtime answers every route with the
// same stable capability state. It used to answer with the sanitized
// internal_error envelope, which the campaign editor rendered as a red
// "an internal error occurred" with a Retry button that could never work.
func TestEveryRouteAnswersNotEnabledWithoutTheRuntime(t *testing.T) {
	run := "/api/v1/campaigns/" + testCampaignID + "/assurance-runs/" + testRunID
	finding := run + "/findings/" + testFindingID
	routes := []struct{ method, path, role string }{
		{http.MethodGet, "/api/v1/campaigns/" + testCampaignID + "/assurance", "viewer"},
		{http.MethodGet, run, "viewer"},
		{http.MethodGet, run + "/manifest", "viewer"},
		{http.MethodGet, run + "/evidence", "viewer"},
		{http.MethodGet, run + "/events", "viewer"},
		{http.MethodPost, "/api/v1/campaigns/" + testCampaignID + "/assurance-runs", "editor"},
		{http.MethodPost, finding + "/apply", "editor"},
		{http.MethodPost, finding + "/overrides", "owner"},
		{http.MethodPost, finding + "/appeals", "owner"},
		{http.MethodPost, run + "/cancel", "editor"},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			router := chi.NewRouter()
			Mount(router, &Deps{})
			request := authenticatedRequest(route.method, route.path, "", route.role)
			request.Header.Set("Idempotency-Key", "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assertNotEnabled(t, recorder)
		})
	}
}

func assertNotEnabled(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if recorder.Header().Get("Retry-After") != "" {
		t.Fatalf("Retry-After = %q on a state retrying cannot change", recorder.Header().Get("Retry-After"))
	}
	var body struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable *bool  `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v; body=%s", err, recorder.Body.String())
	}
	if body.Error.Code != NotEnabledCode || body.Error.Retryable == nil || *body.Error.Retryable ||
		body.Error.Message != "Campaign Assurance is not enabled on this deployment" {
		t.Fatalf("error = %+v; body=%s", body.Error, recorder.Body.String())
	}
}

// With the runtime on, a transient dispatch failure stays retryable and keeps
// its code, so a client can tell it from "not enabled" and from a crash.
func TestTransientUnavailabilityIsRetryableAndNamed(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	(&Deps{}).writeError(recorder, request, errors.Join(ErrDispatchUnavailable, errors.New("secret broker address")))

	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "5" {
		t.Fatalf("status=%d retry=%q", recorder.Code, recorder.Header().Get("Retry-After"))
	}
	var body struct {
		Error struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "campaign_assurance_unavailable" || !body.Error.Retryable {
		t.Fatalf("error = %+v; body=%s", body.Error, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "secret") {
		t.Fatalf("internal detail leaked: %s", recorder.Body.String())
	}
}

func TestMalformedPathFailsBeforeDependencyCalls(t *testing.T) {
	service := &fakeAssuranceService{}
	malformed := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/not-a-uuid/assurance-runs/not-a-run", "", "viewer")
	malformedRecorder := httptest.NewRecorder()
	mountedAssuranceRouter(service).ServeHTTP(malformedRecorder, malformed)
	if malformedRecorder.Code != http.StatusBadRequest || service.detailCalls != 0 {
		t.Fatalf("malformed status=%d calls=%d body=%s", malformedRecorder.Code, service.detailCalls, malformedRecorder.Body.String())
	}
}
