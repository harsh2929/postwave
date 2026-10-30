// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement_test.go — pure-function + handler-guard tests for SUB-036
// segment engagement summary. The rate maths are pure; the DB read is
// exercised by integration suites. No live DB here.

package segments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestComputeEngagementRates(t *testing.T) {
	cases := []struct {
		name                           string
		in                             engagementRawCounts
		wantOpen, wantClick, wantUnsub float64
	}{
		{
			name:      "typical",
			in:        engagementRawCounts{Sends: 200, Opens: 100, Clicks: 40, Unsubs: 2},
			wantOpen:  0.5,
			wantClick: 0.2,
			wantUnsub: 0.01,
		},
		{
			name: "zero sends -> all zero (no divide-by-zero)",
			in:   engagementRawCounts{Sends: 0, Opens: 5, Clicks: 3},
		},
		{
			name:     "all opens",
			in:       engagementRawCounts{Sends: 10, Opens: 10},
			wantOpen: 1.0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o, c, u := computeEngagementRates(tc.in)
			if o != tc.wantOpen || c != tc.wantClick || u != tc.wantUnsub {
				t.Fatalf("rates = (%f,%f,%f), want (%f,%f,%f)", o, c, u, tc.wantOpen, tc.wantClick, tc.wantUnsub)
			}
		})
	}
}

func TestSegmentEngagementSummaryResponseShape(t *testing.T) {
	resp := SegmentEngagementSummaryResponse{
		SegmentID:   "seg-1",
		WindowDays:  90,
		MemberCount: 5,
		Sends:       200,
		Opens:       100,
		Clicks:      40,
		Unsubs:      2,
		RateBasis:   "delivery_outcome_events",
	}
	resp.OpenRate, resp.ClickRate, resp.UnsubRate = computeEngagementRates(engagementRawCounts{
		Sends: resp.Sends, Opens: resp.Opens, Clicks: resp.Clicks, Unsubs: resp.Unsubs,
	})
	b, _ := json.Marshal(resp)
	for _, want := range []string{
		`"open_rate":0.5`, `"click_rate":0.2`, `"rate_basis":"delivery_outcome_events"`, `"member_count":5`,
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("serialised body missing %q: %s", want, string(b))
		}
	}
}

func TestSegmentEngagementSummaryHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/engagement-summary", nil)
	req = withChiID(req, "id", "seg-1")
	rec := httptest.NewRecorder()
	d.SegmentEngagementSummary(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSegmentEngagementSummaryHandlerBadDays(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/engagement-summary?days=9999", nil)
	req = withTenant(withChiID(req, "id", "seg-1"))
	rec := httptest.NewRecorder()
	d.SegmentEngagementSummary(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_days") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
