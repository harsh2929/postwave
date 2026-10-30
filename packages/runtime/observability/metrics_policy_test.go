package observability

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestEmptyTokenNeverGrantsRemoteAccess covers the case the existing table
// does not: an Authorization header presented while the configured token is
// empty.
//
// This is the shape a misconfigured deploy takes. METRICS_TOKEN unset is the
// default state of a service nobody has finished wiring, and /metrics is
// mounted OUTSIDE the internalauth group on all four services — so if an empty
// token ever meant "no check" rather than "loopback only", every one of them
// would publish its metrics to anything that could reach the port.
//
// The existing cases pair an empty token with NO auth header, and a real token
// with various headers. Nothing paired an empty token WITH a header, which is
// exactly where an accidental fail-open would live.
//
// Two things stop it, and only one is obvious. The explicit `token == ""`
// early return is the readable one. The other is that strings.Fields never
// yields an empty field, so no Authorization value can produce an empty
// fields[1] to compare equal against an empty expected token — verified by
// removing the early return, at which point these inputs are still refused.
// Both are asserted so the subtle one cannot be quietly relied upon and then
// lost in a refactor.
func TestEmptyTokenNeverGrantsRemoteAccess(t *testing.T) {
	for _, auth := range []string{
		"",
		"Bearer ",
		"Bearer",
		"Bearer  ",
		"bearer ",
		"Bearer \t",
		"Basic ",
		" Bearer ",
	} {
		r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
		r.RemoteAddr = "203.0.113.10:1234"
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		if MetricsRequestAllowed(r, "") {
			t.Errorf("empty configured token granted access for Authorization %q", auth)
		}
	}
}

// TestConfiguredTokenStillRejectsEmptyCredential is the mirror: a real token
// must not be matchable by a blank credential either.
func TestConfiguredTokenStillRejectsEmptyCredential(t *testing.T) {
	for _, auth := range []string{"Bearer ", "Bearer", "Bearer  "} {
		r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
		r.RemoteAddr = "203.0.113.10:1234"
		r.Header.Set("Authorization", auth)
		if MetricsRequestAllowed(r, "metrics-secret") {
			t.Errorf("blank credential %q was accepted against a real token", auth)
		}
	}
}

// TestLoopbackRecognitionIsAddressBased pins which remote addresses count as
// local. The existing table covers 127.0.0.1 and [::1]; these are the forms a
// hand-rolled string check gets wrong.
//
// net.ParseIP().IsLoopback() unmaps IPv4-in-IPv6 internally, which is why the
// mapped form is correctly treated as loopback here — the same input that
// slipped past the MCP server's hand-written denylist earlier in this audit.
// Delegating to net/netip is what makes this robust, so the mapped case is
// asserted to keep any future rewrite honest.
func TestLoopbackRecognitionIsAddressBased(t *testing.T) {
	cases := []struct {
		remote string
		want   bool
	}{
		{"127.0.0.1:1234", true},
		{"127.0.0.53:1234", true}, // all of 127/8 is loopback
		{"[::1]:1234", true},
		{"[::ffff:127.0.0.1]:1234", true}, // IPv4-mapped IPv6 loopback
		{"203.0.113.10:1234", false},
		{"[2001:db8::1]:1234", false},
		{"localhost:1234", false}, // a name, not an address
		{"", false},
		{"garbage", false},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
		r.RemoteAddr = tc.remote
		if got := MetricsRequestAllowed(r, ""); got != tc.want {
			t.Errorf("remote %q: allowed = %v, want %v", tc.remote, got, tc.want)
		}
	}
}

// TestProtectMetricsFailsClosedOnNilHandler checks the wrapper's own edge: a
// nil next handler must become a 404, not a nil-pointer panic that takes the
// service down through an unauthenticated route.
func TestProtectMetricsFailsClosedOnNilHandler(t *testing.T) {
	h := ProtectMetrics("metrics-secret", nil)

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
	r.RemoteAddr = "127.0.0.1:1234" // allowed, so we reach `next`
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusNotFound {
		t.Errorf("nil handler on an allowed request: got %d, want 404", rec.Code)
	}
	// The hardening headers must be set regardless of the outcome — a 403 body
	// cached by an intermediary is still a disclosure of the policy.
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("Cache-Control: no-store missing")
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("X-Content-Type-Options: nosniff missing")
	}
}
