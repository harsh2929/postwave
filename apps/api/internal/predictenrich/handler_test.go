// SPDX-License-Identifier: AGPL-3.0-only
//
// handler_test.go — verifies the JSON injection logic in isolation.
// The Pool-and-upstream paths require a live database + a running
// deliverability service; those are exercised by the integration
// harness, not here.

package predictenrich

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestInjectEQHistory_NoPoolNoEnrichment(t *testing.T) {
	// With Pool=nil, AvgScoreLast30d returns (0, false, nil) → the
	// body should be passed through unchanged.
	d := &Deps{}
	in := []byte(`{"html":"<p>hi</p>","history":{"open_rate":0.3}}`)
	out, err := d.injectEQHistory(t.Context(), "tenant-1", in)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !bytes.Equal(in, out) {
		t.Fatalf("body mutated unexpectedly:\n in=%s\nout=%s", in, out)
	}
}

func TestForward_PreservesStatusAndBody(t *testing.T) {
	// Spin up a fake upstream and verify the handler proxies the
	// request body + status + response body verbatim.
	var got map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("upstream got non-JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"predicted":{"primary":0.5,"spam":0.2}}`))
	}))
	defer upstream.Close()

	d := &Deps{
		UpstreamBaseURL: upstream.URL,
		UpstreamPath:    "/v1/predict",
	}
	body := []byte(`{"html":"<p>hi</p>"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/predict",
		bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	if err := d.forward(w, req, body); err != nil {
		t.Fatalf("forward: %v", err)
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"primary":0.5`) {
		t.Fatalf("body lost: %q", w.Body.String())
	}
	if got["html"] != "<p>hi</p>" {
		t.Fatalf("upstream did not receive body: %+v", got)
	}
}

func invokeInvalidPrediction(t *testing.T, body []byte, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/predict", bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	(&Deps{}).Handler().ServeHTTP(rec, req)
	return rec
}

func TestHandlerRejectsOversize(t *testing.T) {
	rec := invokeInvalidPrediction(t, bytes.Repeat([]byte("x"), MaxBodyBytes+1), "application/json")
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s, want 413", rec.Code, rec.Body.String())
	}
}

func TestHandlerRequiresJSONContentType(t *testing.T) {
	rec := invokeInvalidPrediction(t, []byte(`{"html":"hello"}`), "")
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status=%d body=%s, want 415", rec.Code, rec.Body.String())
	}
}

func TestHandlerRejectsTrailingJSON(t *testing.T) {
	rec := invokeInvalidPrediction(t, []byte(`{"html":"hello"} {}`), "application/json")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "multiple_json_values") {
		t.Fatalf("status=%d body=%s, want multiple_json_values", rec.Code, rec.Body.String())
	}
}

// DELIVERABILITY_SERVICE_URL=disabled loads as an empty URL. /api/v1/predict
// answered that with a logged 500 internal_error on every call; it is the
// deployment's state, answered as the proxied sidecar routes answer it.
func TestHandlerSaysNotDeployedWithoutTheDeliverabilityService(t *testing.T) {
	rec := invokeInvalidPrediction(t, []byte(`{"html":"<p>hi</p>"}`), "application/json")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s, want 503", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Retryable *bool  `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	if envelope.Error.Code != "service_not_deployed" {
		t.Fatalf("code=%q, want service_not_deployed", envelope.Error.Code)
	}
	if envelope.Error.Retryable == nil || *envelope.Error.Retryable {
		t.Fatalf("retryable=%v, want false: asking again cannot deploy the service", envelope.Error.Retryable)
	}
}
