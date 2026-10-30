// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProtectRoute43ResponsesCoversEarlyRefusalsAndRestampsWrites(t *testing.T) {
	for _, target := range []string{
		"/api/v1/push/suppressions",
		"/api/v1/push/suppressions/",
		"/api/v1/push/suppressions/bulk-import",
		"/api/v1/push/suppressions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	} {
		t.Run(target, func(t *testing.T) {
			handler := ProtectRoute43Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				// Simulate an earlier auth/body/version layer weakening headers.
				w.Header().Set("Cache-Control", "public, max-age=3600")
				w.Header().Set("Pragma", "cache")
				w.Header().Set("X-Content-Type-Options", "")
				w.Header().Set("ETag", `"private-row"`)
				http.Error(w, `{"error":{"code":"early_refusal"}}`, http.StatusUnauthorized)
			}))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
			assertPrivateBoundary(t, recorder.Header())
		})
	}
}

func TestProtectRoute43ResponsesLeavesOtherPathsUntouched(t *testing.T) {
	handler := ProtectRoute43Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("ETag", `"public"`)
		w.WriteHeader(http.StatusTeapot)
	}))
	for _, target := range []string{
		"/api/v1/push/suppression",
		"/api/v1/push/suppressions-other",
		"/api/v1/push/devices",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=60" {
			t.Fatalf("%s Cache-Control=%q", target, got)
		}
		if got := recorder.Header().Get("ETag"); got != `"public"` {
			t.Fatalf("%s ETag=%q", target, got)
		}
	}
}

func assertPrivateBoundary(t *testing.T, header http.Header) {
	t.Helper()
	if got := header.Get("Cache-Control"); got != "private, no-store, max-age=0" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := header.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma=%q", got)
	}
	if got := header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q", got)
	}
	if got := header.Get("ETag"); got != "" {
		t.Fatalf("ETag leaked: %q", got)
	}
}
