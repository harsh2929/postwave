package views

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeCampaignAssuranceOps struct {
	page        CampaignAssuranceRunPage
	detail      *CampaignAssuranceRunDetail
	timeline    *CampaignAssuranceTimelinePage
	err         error
	listCalls   int
	detailCalls int
	timeCalls   int
	filter      CampaignAssuranceRunFilter
	runID       string
	after       int64
	limit       int
}

func (f *fakeCampaignAssuranceOps) ListCampaignAssuranceRuns(
	_ context.Context,
	filter CampaignAssuranceRunFilter,
) (CampaignAssuranceRunPage, error) {
	f.listCalls++
	f.filter = filter
	return f.page, f.err
}

func (f *fakeCampaignAssuranceOps) CampaignAssuranceRunDetailByID(
	_ context.Context,
	runID string,
) (*CampaignAssuranceRunDetail, error) {
	f.detailCalls++
	f.runID = runID
	return f.detail, f.err
}

func (f *fakeCampaignAssuranceOps) CampaignAssuranceRunTimeline(
	_ context.Context,
	runID string,
	after int64,
	limit int,
) (*CampaignAssuranceTimelinePage, error) {
	f.timeCalls++
	f.runID, f.after, f.limit = runID, after, limit
	return f.timeline, f.err
}

func TestCampaignAssuranceRunsHandler_StrictFiltersAndFailLoud(t *testing.T) {
	cursor := encodeCampaignAssuranceCursor(time.Unix(100, 0), testAssuranceRunID)
	fake := &fakeCampaignAssuranceOps{page: CampaignAssuranceRunPage{
		Runs: []CampaignAssuranceRunRow{{
			TenantID: testAssuranceTenantID,
			RunID:    testAssuranceRunID,
		}},
	}}
	handler := CampaignAssuranceRunsHandler(fake)
	w := httptest.NewRecorder()
	handler(w, httptest.NewRequest(http.MethodGet,
		"/views/campaign-assurance/runs?tenant_id="+testAssuranceTenantID+
			"&state=running&limit=17&cursor="+cursor, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	assertViewHeaders(t, w)
	if fake.listCalls != 1 || fake.filter.TenantID != testAssuranceTenantID ||
		fake.filter.State != "running" || fake.filter.Limit != 17 ||
		fake.filter.Cursor != cursor {
		t.Fatalf("filter not propagated: calls=%d filter=%+v", fake.listCalls, fake.filter)
	}
	if strings.Contains(strings.ToLower(w.Body.String()), "subject") ||
		strings.Contains(strings.ToLower(w.Body.String()), "raw_output") {
		t.Fatalf("content-bearing field escaped: %s", w.Body.String())
	}

	invalidTargets := []string{
		"/views/campaign-assurance/runs?unknown=1",
		"/views/campaign-assurance/runs?tenant_id=nope",
		"/views/campaign-assurance/runs?tenant_id=" + testAssuranceTenantID + "&tenant_id=" + testAssuranceTenantID,
		"/views/campaign-assurance/runs?state=done",
		"/views/campaign-assurance/runs?cursor=nope",
		"/views/campaign-assurance/runs?limit=0",
		"/views/campaign-assurance/runs?limit=501",
		"/views/campaign-assurance/runs?limit=one",
	}
	for _, target := range invalidTargets {
		fake := &fakeCampaignAssuranceOps{}
		w := httptest.NewRecorder()
		CampaignAssuranceRunsHandler(fake)(w,
			httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusBadRequest || fake.listCalls != 0 {
			t.Errorf("target=%q status=%d calls=%d body=%s", target, w.Code, fake.listCalls, w.Body.String())
		}
		assertViewHeaders(t, w)
	}

	failing := &fakeCampaignAssuranceOps{err: context.DeadlineExceeded}
	w = httptest.NewRecorder()
	CampaignAssuranceRunsHandler(failing)(w,
		httptest.NewRequest(http.MethodGet, "/views/campaign-assurance/runs", nil))
	if w.Code != http.StatusInternalServerError || failing.listCalls != 1 {
		t.Fatalf("failed read must be loud: status=%d calls=%d", w.Code, failing.listCalls)
	}
	assertViewHeaders(t, w)
}

func TestCampaignAssuranceRunDetailHandler_ValidationMissingAndFailure(t *testing.T) {
	tests := []struct {
		name   string
		runID  string
		target string
		fake   *fakeCampaignAssuranceOps
		want   int
		calls  int
	}{
		{name: "malformed id", runID: "nope", target: "/runs/nope", fake: &fakeCampaignAssuranceOps{}, want: http.StatusBadRequest},
		{name: "query rejected", runID: testAssuranceRunID, target: "/runs/id?content=1", fake: &fakeCampaignAssuranceOps{}, want: http.StatusBadRequest},
		{name: "missing", runID: testAssuranceRunID, target: "/runs/id", fake: &fakeCampaignAssuranceOps{}, want: http.StatusNotFound, calls: 1},
		{name: "failure", runID: testAssuranceRunID, target: "/runs/id", fake: &fakeCampaignAssuranceOps{err: errors.New("db unavailable")}, want: http.StatusInternalServerError, calls: 1},
		{name: "ok", runID: testAssuranceRunID, target: "/runs/id", fake: &fakeCampaignAssuranceOps{detail: &CampaignAssuranceRunDetail{CampaignAssuranceRunRow: CampaignAssuranceRunRow{TenantID: testAssuranceTenantID, RunID: testAssuranceRunID}}}, want: http.StatusOK, calls: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			request := withURLParam(httptest.NewRequest(http.MethodGet, test.target, nil), "id", test.runID)
			CampaignAssuranceRunDetailHandler(test.fake)(w, request)
			if w.Code != test.want || test.fake.detailCalls != test.calls {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, test.fake.detailCalls, w.Body.String())
			}
			assertViewHeaders(t, w)
		})
	}
}

func TestCampaignAssuranceRunTimelineHandler_BoundedCursorAndFailLoud(t *testing.T) {
	fake := &fakeCampaignAssuranceOps{timeline: &CampaignAssuranceTimelinePage{
		TenantID: testAssuranceTenantID,
		RunID:    testAssuranceRunID,
		Events:   []CampaignAssuranceTimelineEvent{},
	}}
	w := httptest.NewRecorder()
	request := withURLParam(httptest.NewRequest(http.MethodGet,
		"/runs/id/timeline?after=12&limit=23", nil), "id", testAssuranceRunID)
	CampaignAssuranceRunTimelineHandler(fake)(w, request)
	if w.Code != http.StatusOK || fake.timeCalls != 1 || fake.after != 12 || fake.limit != 23 {
		t.Fatalf("status=%d calls=%d after=%d limit=%d body=%s", w.Code, fake.timeCalls, fake.after, fake.limit, w.Body.String())
	}
	assertViewHeaders(t, w)

	invalidTargets := []string{
		"/runs/id/timeline?after=-1",
		"/runs/id/timeline?after=one",
		"/runs/id/timeline?after=1&after=2",
		"/runs/id/timeline?limit=0",
		"/runs/id/timeline?limit=501",
		"/runs/id/timeline?metadata=1",
	}
	for _, target := range invalidTargets {
		fake := &fakeCampaignAssuranceOps{}
		w := httptest.NewRecorder()
		request := withURLParam(httptest.NewRequest(http.MethodGet, target, nil), "id", testAssuranceRunID)
		CampaignAssuranceRunTimelineHandler(fake)(w, request)
		if w.Code != http.StatusBadRequest || fake.timeCalls != 0 {
			t.Errorf("target=%q status=%d calls=%d body=%s", target, w.Code, fake.timeCalls, w.Body.String())
		}
	}

	failing := &fakeCampaignAssuranceOps{err: context.DeadlineExceeded}
	w = httptest.NewRecorder()
	request = withURLParam(httptest.NewRequest(http.MethodGet, "/runs/id/timeline", nil), "id", testAssuranceRunID)
	CampaignAssuranceRunTimelineHandler(failing)(w, request)
	if w.Code != http.StatusInternalServerError || failing.timeCalls != 1 {
		t.Fatalf("failed timeline must be loud: status=%d calls=%d", w.Code, failing.timeCalls)
	}
}
