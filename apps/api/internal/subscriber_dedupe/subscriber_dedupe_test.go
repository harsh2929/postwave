// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_dedupe

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestScanRoutesRequireTenant(t *testing.T) {
	deps := &Deps{}
	for _, test := range []struct {
		name string
		call func(*httptest.ResponseRecorder, *http.Request)
	}{
		{"legacy complete list", func(w *httptest.ResponseRecorder, r *http.Request) { deps.List(w, r) }},
		{"start", func(w *httptest.ResponseRecorder, r *http.Request) { deps.StartScan(w, r) }},
		{"metadata", func(w *httptest.ResponseRecorder, r *http.Request) { deps.GetScan(w, r) }},
		{"pairs", func(w *httptest.ResponseRecorder, r *http.Request) { deps.ListScanPairs(w, r) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "/api/v1/subscribers/duplicate-scans", nil)
			response := httptest.NewRecorder()
			test.call(response, request)
			if response.Code != 401 {
				t.Fatalf("status = %d, want 401 without tenant", response.Code)
			}
		})
	}
}

func TestCursorAndLimitParsingIsBounded(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want int
	}{
		{"", defaultScanPageSize},
		{"bad", defaultScanPageSize},
		{"0", defaultScanPageSize},
		{"12", 12},
		{"999999", maxScanPageSize},
	} {
		if got := parsePageLimit(test.raw); got != test.want {
			t.Errorf("parsePageLimit(%q) = %d, want %d", test.raw, got, test.want)
		}
	}
	for _, raw := range []string{"-1", "not-a-cursor", "1.5"} {
		if _, err := parseCursor(raw); err == nil {
			t.Errorf("parseCursor(%q) unexpectedly succeeded", raw)
		}
	}
	if value, err := parseCursor("42"); err != nil || value != 42 {
		t.Fatalf("parseCursor(42) = %d, %v", value, err)
	}
}
