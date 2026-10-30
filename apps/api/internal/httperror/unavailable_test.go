// SPDX-License-Identifier: AGPL-3.0-only

package httperror

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteUnavailableKeepsTheCapabilityCode(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	recorder.Header().Set("Cache-Control", "private, max-age=10, stale-while-revalidate=60")

	WriteUnavailable(recorder, "campaign_assurance_not_enabled",
		"Campaign Assurance is not enabled on this deployment", false)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	// A cached "not enabled" would outlive the deployment change that enables it.
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
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
	if body.Error.Code != "campaign_assurance_not_enabled" {
		t.Fatalf("code = %q; body=%s", body.Error.Code, recorder.Body.String())
	}
	if body.Error.Message != "Campaign Assurance is not enabled on this deployment" {
		t.Fatalf("message = %q", body.Error.Message)
	}
	if body.Error.Retryable == nil || *body.Error.Retryable {
		t.Fatalf("retryable = %v, want an explicit false", body.Error.Retryable)
	}
}

// Anything that is not a stable capability code is treated like any other
// 5xx: the caller learns nothing from it.
func TestWriteUnavailableSanitizesAnythingThatIsNotACapabilityCode(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"", "Upstream Failed", "dial tcp 10.0.0.1:5432: refused", "x"} {
		recorder := httptest.NewRecorder()
		WriteUnavailable(recorder, code, "pq: relation \"secrets\" does not exist", true)
		var body struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if recorder.Code != http.StatusServiceUnavailable || body.Error.Code != CodeInternal ||
			body.Error.Message != MessageInternal {
			t.Fatalf("code %q: got %d %+v, want the sanitized 503", code, recorder.Code, body.Error)
		}
	}
}
