// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProtectCredentialResponsesCoversEarlyAndReassertedOutcomes(t *testing.T) {
	for _, path := range []string{"/api/v1/streams/token", "/api/v1/api-keys/me"} {
		t.Run(path, func(t *testing.T) {
			handler := ProtectCredentialResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
					t.Fatal("conditional credential request reached inner handler")
				}
				w.Header().Set("Cache-Control", "public, max-age=3600")
				w.Header().Set("ETag", `"secret"`)
				w.WriteHeader(http.StatusForbidden)
			}))
			request := httptest.NewRequest(http.MethodPost, path, nil)
			request.Header.Set("If-None-Match", `"secret"`)
			request.Header.Set("If-Modified-Since", "yesterday")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d", response.Code)
			}
			if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Fatalf("cache-control=%q", got)
			}
			if response.Header().Get("ETag") != "" {
				t.Fatalf("etag survived: %q", response.Header().Get("ETag"))
			}
			vary := strings.Join(response.Header().Values("Vary"), ",")
			if !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
				t.Fatalf("vary=%q", vary)
			}
		})
	}
}

func TestProtectCredentialResponsesDoesNotMatchSibling(t *testing.T) {
	handler := ProtectCredentialResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public")
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/api-keys/meeting", nil))
	if got := response.Header().Get("Cache-Control"); got != "public" {
		t.Fatalf("sibling unexpectedly protected: %q", got)
	}
}
