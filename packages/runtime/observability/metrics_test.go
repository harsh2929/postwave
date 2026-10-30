package observability

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetricsRequestAllowed(t *testing.T) {
	cases := []struct {
		name       string
		remote     string
		token      string
		authValues []string
		forwarded  string
		want       bool
	}{
		{name: "IPv4 loopback", remote: "127.0.0.1:1234", want: true},
		{name: "IPv6 loopback", remote: "[::1]:1234", want: true},
		{name: "loopback hostname rejected", remote: "localhost:1234"},
		{name: "remote no token", remote: "203.0.113.10:1234"},
		{name: "spoofed forwarded loopback", remote: "203.0.113.10:1234", forwarded: "127.0.0.1"},
		{name: "valid bearer", remote: "203.0.113.10:1234", token: "metrics-secret", authValues: []string{"Bearer metrics-secret"}, want: true},
		{name: "case-insensitive scheme", remote: "203.0.113.10:1234", token: "metrics-secret", authValues: []string{"bearer metrics-secret"}, want: true},
		{name: "wrong bearer", remote: "203.0.113.10:1234", token: "metrics-secret", authValues: []string{"Bearer wrong"}},
		{name: "duplicate auth", remote: "203.0.113.10:1234", token: "metrics-secret", authValues: []string{"Bearer metrics-secret", "Bearer metrics-secret"}},
		{name: "extra field", remote: "203.0.113.10:1234", token: "metrics-secret", authValues: []string{"Bearer metrics-secret extra"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
			r.RemoteAddr = tc.remote
			for _, value := range tc.authValues {
				r.Header.Add("Authorization", value)
			}
			if tc.forwarded != "" {
				r.Header.Set("X-Forwarded-For", tc.forwarded)
				r.Header.Set("Forwarded", "for="+tc.forwarded)
			}
			if got := MetricsRequestAllowed(r, tc.token); got != tc.want {
				t.Fatalf("MetricsRequestAllowed() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestProtectMetrics(t *testing.T) {
	protected := ProtectMetrics("metrics-secret", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name   string
		remote string
		auth   string
		status int
	}{
		{name: "denied", remote: "203.0.113.10:1234", status: http.StatusForbidden},
		{name: "token", remote: "203.0.113.10:1234", auth: "Bearer metrics-secret", status: http.StatusNoContent},
		{name: "loopback", remote: "127.0.0.1:1234", status: http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://service/metrics", nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("Authorization", tc.auth)
			w := httptest.NewRecorder()
			protected.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if got := w.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
		})
	}
}
