// SPDX-License-Identifier: AGPL-3.0-only
package dmarc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func withTestTenant(request *http.Request) *http.Request {
	return request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"},
	))
}

func assertSensitiveResponseHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get("Cache-Control"); got != "private, no-store, max-age=0" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := response.Header().Get("Pragma"); got != "no-cache" {
		t.Errorf("Pragma = %q", got)
	}
	if got := response.Header().Get("Expires"); got != "0" {
		t.Errorf("Expires = %q", got)
	}
}

func responseErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response body %q: %v", response.Body.String(), err)
	}
	return envelope.Error.Code
}
