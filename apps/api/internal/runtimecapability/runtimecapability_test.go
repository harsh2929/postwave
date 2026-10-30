package runtimecapability

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteUnavailableIsStableNonRetryableCapabilityError(t *testing.T) {
	descriptor := Unavailable("test_runtime", "test_runtime_unavailable", "Test runtime is unavailable.", "durable_worker")
	recorder := httptest.NewRecorder()

	WriteUnavailable(recorder, descriptor)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if got := recorder.Header().Get("X-Postwave-Capability-Status"); got != StatusUnavailable {
		t.Fatalf("capability header = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
	var body struct {
		Error struct {
			Code          string `json:"code"`
			Capability    string `json:"capability"`
			RuntimeStatus string `json:"runtime_status"`
			Retryable     bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != descriptor.Code || body.Error.Capability != descriptor.Capability ||
		body.Error.RuntimeStatus != StatusUnavailable || body.Error.Retryable {
		t.Fatalf("unexpected error contract: %+v", body.Error)
	}
}
