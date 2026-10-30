// SPDX-License-Identifier: AGPL-3.0-only
package apikeycalls

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProtectMCPResponsesCoversEarlyRefusalsAndReassertsAtCommit(t *testing.T) {
	t.Parallel()
	handler := ProtectMCPResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
			t.Error("conditional request headers reached protected handler")
		}
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("ETag", `"sensitive"`)
		w.Header().Add("Vary", "Accept-Encoding")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))

	for _, path := range []string{
		"/api/v1/mcp",
		"/api/v1/mcp/executions",
		"/api/v1/mcp/executions/stream?stream_token=secret",
		"/api/v1/mcp/rpc",
		"/api/v1/mcp/server/settings",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("If-None-Match", `"sensitive"`)
		request.Header.Set("If-Modified-Since", "yesterday")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Errorf("%s Cache-Control=%q", path, got)
		}
		if got := response.Header().Get("ETag"); got != "" {
			t.Errorf("%s ETag=%q", path, got)
		}
		vary := strings.ToLower(strings.Join(response.Header().Values("Vary"), ","))
		for _, dimension := range []string{"authorization", "cookie", "accept-encoding"} {
			if !strings.Contains(vary, dimension) {
				t.Errorf("%s Vary=%q missing %q", path, vary, dimension)
			}
		}
	}
}

func TestProtectMCPResponsesLeavesSiblingPrefixesUntouched(t *testing.T) {
	t.Parallel()
	handler := ProtectMCPResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("ETag", `"public"`)
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, path := range []string{"/api/v1/mcpx", "/api/v1/campaigns", "/api/v1/mc"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if got := response.Header().Get("Cache-Control"); got != "public, max-age=60" {
			t.Fatalf("%s Cache-Control=%q", path, got)
		}
		if got := response.Header().Get("ETag"); got != `"public"` {
			t.Fatalf("%s ETag=%q", path, got)
		}
	}
}
