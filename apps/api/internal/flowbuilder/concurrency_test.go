// SPDX-License-Identifier: AGPL-3.0-only

package flowbuilder

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequireFlowIfMatchRequiresOneExactStrongCurrentToken(t *testing.T) {
	t.Parallel()
	flow := &Flow{
		ID:        "flow-1",
		UpdatedAt: time.Date(2026, time.September, 3, 10, 0, 0, 123000, time.UTC),
	}
	current := flowETag(flow)
	tests := []struct {
		name       string
		header     string
		second     string
		wantOK     bool
		wantStatus int
	}{
		{name: "missing", wantStatus: http.StatusPreconditionRequired},
		{name: "wildcard", header: "*", wantStatus: http.StatusPreconditionRequired},
		{name: "weak", header: "W/" + current, wantStatus: http.StatusPreconditionFailed},
		{name: "list", header: current + `, "stale"`, wantStatus: http.StatusPreconditionFailed},
		{name: "two lines", header: current, second: `"stale"`, wantStatus: http.StatusPreconditionFailed},
		{name: "stale", header: `"flow:flow-1:v1"`, wantStatus: http.StatusPreconditionFailed},
		{name: "exact", header: current, wantOK: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodPatch, "/flows/flow-1", strings.NewReader(`{}`))
			if test.header != "" {
				req.Header.Add("If-Match", test.header)
			}
			if test.second != "" {
				req.Header.Add("If-Match", test.second)
			}
			recorder := httptest.NewRecorder()
			got := requireFlowIfMatch(recorder, req, flow)
			if got != test.wantOK {
				t.Fatalf("ok = %v; want %v; status=%d body=%s", got, test.wantOK, recorder.Code, recorder.Body.String())
			}
			if !test.wantOK && recorder.Code != test.wantStatus {
				t.Fatalf("status = %d; want %d; body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
		})
	}
}

func TestWriteFlowResponsePairsHeaderAndBodyValidator(t *testing.T) {
	t.Parallel()
	flow := &Flow{
		ID:        "flow-1",
		UpdatedAt: time.Date(2026, time.September, 3, 10, 0, 0, 123000, time.UTC),
	}
	recorder := httptest.NewRecorder()
	writeFlowResponse(recorder, http.StatusOK, flow)

	if flow.ETag == "" || recorder.Header().Get("ETag") != flow.ETag {
		t.Fatalf("header ETag = %q, body ETag = %q", recorder.Header().Get("ETag"), flow.ETag)
	}
	var body Flow
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ETag != flow.ETag {
		t.Fatalf("body ETag = %q; want %q", body.ETag, flow.ETag)
	}
}
