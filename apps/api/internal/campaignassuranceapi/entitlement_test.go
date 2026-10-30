// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

// Starting a run is the only operation on this surface that costs money: a
// `full` profile fans out to eight model members per scenario and reserves its
// worst-case spend before the first provider call. Reads are free and stay
// ungated.

type fakePlanLimiter struct {
	err      error
	calls    int
	resource limits.Resource
	tenantID string
}

func (f *fakePlanLimiter) Check(_ context.Context, tenantID string, resource limits.Resource, _ int) error {
	f.calls++
	f.tenantID = tenantID
	f.resource = resource
	return f.err
}

func mountedAssuranceRouterWithLimiter(
	service AssuranceService,
	preparer SnapshotPreparer,
	limiter PlanLimiter,
) http.Handler {
	router := chi.NewRouter()
	Mount(router, &Deps{Service: service, Preparer: preparer, Entitlements: limiter})
	return router
}

func createRunRequestWithKey(key string) *http.Request {
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs", validCreateBody(), "editor")
	request.Header.Set(idempotency.HeaderName, key)
	return request
}

func TestCreateRunIsDeniedWhenThePlanAllowanceIsSpent(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun: &run, startSources: []string{campaignassurance.SourceDeterministic},
	}
	limiter := &fakePlanLimiter{err: &limits.Error{
		Resource: limits.ResourceAssuranceRuns, Tier: "sending", Limit: 400, Current: 400,
	}}
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithLimiter(service, nil, limiter).
		ServeHTTP(recorder, createRunRequestWithKey("create-over-allowance"))

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("status=%d body=%s, want 402", recorder.Code, recorder.Body.String())
	}
	// The shared plan-denial envelope, so every client already knows how to
	// render it and the remedy is not reinvented here.
	body := recorder.Body.String()
	for _, want := range []string{
		`"code":"plan_limit_exceeded"`,
		`"resource":"assurance_runs"`,
		`"tier":"sending"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("denial body missing %s: %s", want, body)
		}
	}
	// A denied request must not reach the durable run lifecycle at all.
	if service.startCalls != 0 {
		t.Errorf("StartRun called %d times on a denied request, want 0", service.startCalls)
	}
	if limiter.resource != limits.ResourceAssuranceRuns {
		t.Errorf("metered resource = %q, want assurance_runs", limiter.resource)
	}
	if limiter.tenantID != testTenantID {
		t.Errorf("metered tenant = %q, want %q", limiter.tenantID, testTenantID)
	}
}

// Preparation compiles and materialises the complete scenario set — the most
// expensive work on the request path. Checking the allowance after it would
// still bill the compute for a run the tenant is not allowed to start.
func TestCreateRunChecksTheAllowanceBeforePreparingArtifacts(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun: &run, startSources: []string{campaignassurance.SourceDeterministic},
	}
	preparer := &fakeSnapshotPreparer{result: PreparedSnapshot{
		ContentRevisionID: testRevisionID, SendPlanID: testPlanID,
	}}
	limiter := &fakePlanLimiter{err: &limits.Error{
		Resource: limits.ResourceAssuranceRuns, Tier: "studio", Limit: 20, Current: 20,
	}}
	request := authenticatedRequest(http.MethodPost,
		"/api/v1/campaigns/"+testCampaignID+"/assurance-runs",
		`{"request_id":"`+testRequestID+`","profile":"full"}`, "editor")
	request.Header.Set(idempotency.HeaderName, "create-denied-before-prepare")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithLimiter(service, preparer, limiter).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("status=%d body=%s, want 402", recorder.Code, recorder.Body.String())
	}
	if preparer.calls != 0 {
		t.Errorf("snapshot preparation ran %d times for a denied request, want 0", preparer.calls)
	}
}

// An unwired meter must refuse rather than serve unmetered runs. Silently
// allowing them is the same failure shape as a sandboxed SES region: it looks
// like it is working right up until the bill.
func TestCreateRunRefusesWhenNoMeterIsConfigured(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun: &run, startSources: []string{campaignassurance.SourceDeterministic},
	}
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithLimiter(service, nil, nil).
		ServeHTTP(recorder, createRunRequestWithKey("create-without-meter"))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s, want 503", recorder.Code, recorder.Body.String())
	}
	if service.startCalls != 0 {
		t.Errorf("StartRun called %d times with no meter configured, want 0", service.startCalls)
	}
}

func TestCreateRunProceedsWhenWithinAllowance(t *testing.T) {
	run := testRun()
	service := &fakeAssuranceService{
		startRun: &run, startSources: []string{campaignassurance.SourceDeterministic},
	}
	limiter := &fakePlanLimiter{}
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithLimiter(service, nil, limiter).
		ServeHTTP(recorder, createRunRequestWithKey("create-within-allowance"))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s, want 202", recorder.Code, recorder.Body.String())
	}
	if limiter.calls != 1 {
		t.Errorf("meter consulted %d times, want exactly 1", limiter.calls)
	}
	if service.startCalls != 1 {
		t.Errorf("StartRun called %d times, want 1", service.startCalls)
	}
}

// Reads must never be metered: a tenant at their allowance still has to be able
// to see the receipt for the runs they already paid for.
func TestReadingAnAssuranceReceiptIsNotMetered(t *testing.T) {
	run := testRun()
	detail := &RunDetail{
		Run: run, Manifest: *testManifest(run),
		SourceClasses: []string{campaignassurance.SourceDeterministic},
	}
	service := &fakeAssuranceService{latestResult: detail}
	limiter := &fakePlanLimiter{err: &limits.Error{
		Resource: limits.ResourceAssuranceRuns, Tier: "studio", Limit: 20, Current: 20,
	}}
	request := authenticatedRequest(http.MethodGet,
		"/api/v1/campaigns/"+testCampaignID+"/assurance", "", "viewer")
	recorder := httptest.NewRecorder()

	mountedAssuranceRouterWithLimiter(service, nil, limiter).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200", recorder.Code, recorder.Body.String())
	}
	if limiter.calls != 0 {
		t.Errorf("meter consulted %d times on a read, want 0", limiter.calls)
	}
}
