package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// When the DMARC store is not configured (dev/local without DATABASE_URL, so
// dmarcStore stays nil) every DMARC route must short-circuit to 503 with the
// "dmarc storage not configured" body — the nil-guard is the test seam since
// *auth.Store is concrete and cannot be faked without a DB.
func TestGetDMARCRoutesReturn503WhenStorageDisabled(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: fakeRenderer{}}) // DMARC defaults nil

	cases := []struct{ name, target string }{
		{"list", "/v1/dmarc/reports"},
		{"detail", "/v1/dmarc/reports/some-id"},
		{"stats", "/v1/dmarc/stats"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			// A tenant header is present, proving the nil-guard fires FIRST
			// (before the tenant guard) so a disabled store never leaks a
			// tenant error.
			req.Header.Set("X-Tenant-ID", "tnt_1")
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "dmarc storage not configured") {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}

// The nil-guard must precede the tenant guard: even with NO tenant header, a
// disabled store returns 503 (not the 401 tenant-required path).
func TestGetDMARCStatsNilGuardBeatsTenantGuard(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: fakeRenderer{}})

	req := httptest.NewRequest(http.MethodGet, "/v1/dmarc/stats", nil) // no tenant header
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "dmarc storage not configured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAtoiDefault(t *testing.T) {
	cases := []struct {
		in  string
		def int
		out int
	}{
		{"", 50, 50},
		{"7", 50, 7},
		{"garbage", 50, 50},
		{"-3", 0, -3},
		{"0", 50, 0},
	}
	for _, tc := range cases {
		if got := atoiDefault(tc.in, tc.def); got != tc.out {
			t.Errorf("atoiDefault(%q, %d) = %d, want %d", tc.in, tc.def, got, tc.out)
		}
	}
}
