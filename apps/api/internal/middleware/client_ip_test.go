// SPDX-License-Identifier: AGPL-3.0-only
//
// client_ip_test.go — coverage matrix for the unified ResolveClientIP
// resolver. Every other limiter / allowlist in the codebase routes IP
// resolution through this helper, so the test surface here is the
// single source of truth for trust-posture behaviour.

package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newReq(remote, xff, xri string) *http.Request {
	r := httptest.NewRequest("GET", "/x", nil)
	if remote != "" {
		r.RemoteAddr = remote
	}
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	if xri != "" {
		r.Header.Set("X-Real-IP", xri)
	}
	return r
}

func TestResolveClientIP_Matrix(t *testing.T) {
	// Reset trusted proxies between tests to keep cases hermetic.
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()

	cases := []struct {
		name           string
		trustHeaders   bool
		trustedProxies []string
		remoteAddr     string
		xff            string
		xri            string
		want           string // "" means we expect nil
	}{
		{
			name:         "trust=false ignores XFF and X-Real-IP",
			trustHeaders: false,
			remoteAddr:   "10.0.0.5:54321",
			xff:          "203.0.113.99",
			xri:          "198.51.100.7",
			want:         "10.0.0.5",
		},
		{
			name:         "trust=false strips IPv6 brackets and port",
			trustHeaders: false,
			remoteAddr:   "[2001:db8::1]:443",
			want:         "2001:db8::1",
		},
		{
			name:           "trusted peer may supply X-Real-IP when XFF absent",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xri:            "198.51.100.7",
			want:           "198.51.100.7",
		},
		{
			name:         "trust flag without trusted set ignores XFF",
			trustHeaders: true,
			remoteAddr:   "10.0.0.5:1",
			xff:          "203.0.113.99",
			want:         "10.0.0.5",
		},
		{
			name:           "trusted peer rightmost untrusted XFF wins",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "203.0.113.99, 198.51.100.7",
			want:           "198.51.100.7",
		},
		{
			name:           "untrusted direct peer cannot inject XFF even when trust flag is on",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "198.51.100.44:1",
			xff:            "127.0.0.1",
			want:           "198.51.100.44",
		},
		{
			name:           "trust=true rightmost in trusted set → walk left",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "203.0.113.99, 10.1.2.3",
			want:           "203.0.113.99",
		},
		{
			name:           "every XFF hop trusted falls back to authenticated peer",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8", "172.16.0.0/12"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "10.0.0.99, 172.16.5.5",
			want:           "10.0.0.5",
		},
		{
			name:           "malformed XFF chain falls back to authenticated peer",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "203.0.113.99, not-an-ip",
			want:           "10.0.0.5",
		},
		{
			name:           "trust=true accepts bracketed IPv6 in XFF",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "[2001:db8::99]",
			want:           "2001:db8::99",
		},
		{
			name:           "trust=true strips IPv6 zone suffix",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "fe80::1%eth0",
			want:           "fe80::1",
		},
		{
			name:         "trust=true falls through to RemoteAddr when XFF/XRI empty",
			trustHeaders: true,
			remoteAddr:   "192.0.2.1:9000",
			want:         "192.0.2.1",
		},
		{
			name:           "trust=true preserves XFF over RemoteAddr",
			trustHeaders:   true,
			trustedProxies: []string{"10.0.0.0/8"},
			remoteAddr:     "10.0.0.5:1",
			xff:            "203.0.113.99",
			want:           "203.0.113.99",
		},
		{
			name:         "unresolvable RemoteAddr returns nil",
			trustHeaders: false,
			remoteAddr:   "not-an-address",
			want:         "",
		},
		{
			name:         "bare IPv6 RemoteAddr without port",
			trustHeaders: false,
			remoteAddr:   "2001:db8::ff",
			want:         "2001:db8::ff",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_ = SetTrustedProxyCIDRs(tc.trustedProxies)
			r := newReq(tc.remoteAddr, tc.xff, tc.xri)
			got := ResolveClientIP(r, tc.trustHeaders)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("want nil, got %s", got.String())
				}
				return
			}
			if got == nil {
				t.Fatalf("want %s, got nil", tc.want)
			}
			if got.String() != tc.want {
				t.Fatalf("want %s, got %s", tc.want, got.String())
			}
		})
	}
}

func TestResolveClientIPString_NilRequest(t *testing.T) {
	if got := ResolveClientIP(nil, true); got != nil {
		t.Fatalf("want nil for nil request, got %s", got.String())
	}
	if got := ResolveClientIPString(nil, false); got != "" {
		t.Fatalf("want empty string for nil request, got %q", got)
	}
}

func TestResolveClientIPString_Roundtrip(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	r := newReq("10.0.0.5:1", "203.0.113.99", "")
	if got := ResolveClientIPString(r, true); got != "203.0.113.99" {
		t.Fatalf("want 203.0.113.99 got %q", got)
	}
}

func TestSetTrustedProxyCIDRsRejectsInvalidConfiguration(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	_ = SetTrustedProxyCIDRs(nil)
	err := SetTrustedProxyCIDRs([]string{
		"10.0.0.0/8",
		"203.0.113.1", // bare IPv4 → /32
		"this-is-not-an-ip",
	})
	if err == nil {
		t.Fatal("invalid trusted proxy entry must reject the configuration")
	}
	if TrustedProxyCIDRsConfigured() {
		t.Fatal("rejected configuration must not install a partial trust set")
	}
}

func TestSetTrustedProxyCIDRsRejectsTrustEveryoneNetworks(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	for _, cidr := range []string{"0.0.0.0/0", "::/0"} {
		if err := SetTrustedProxyCIDRs([]string{cidr}); err == nil {
			t.Fatalf("SetTrustedProxyCIDRs(%q) accepted a trust-everyone network", cidr)
		}
	}
}

func TestValidateAdminAllowlistMount(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	cases := []struct {
		name         string
		trustHeaders bool
		directPeer   bool
		wantErr      bool
	}{
		{"trust headers → safe", true, false, false},
		{"trust headers + direct → safe", true, true, false},
		{"no trust + direct → safe", false, true, false},
		{"no trust + no direct → refused", false, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_ = SetTrustedProxyCIDRs(nil)
			if tc.trustHeaders {
				if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
					t.Fatal(err)
				}
			}
			err := ValidateAdminAllowlistMount(tc.trustHeaders, tc.directPeer)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got nil")
				}
				var aErr *AdminAllowlistMountError
				if !errors.As(err, &aErr) {
					t.Fatalf("want *AdminAllowlistMountError, got %T", err)
				}
				if aErr.Error() == "" {
					t.Fatalf("error message should be non-empty")
				}
				return
			}
			if err != nil {
				t.Fatalf("want nil error, got %v", err)
			}
		})
	}
}

// TestResolveClientIP_TrustToggleConsistency asserts the resolver
// returns the same IP for both the same trust posture across
// repeated calls — guards against accidental hidden state in
// SetTrustedProxyCIDRs / atomic-pointer swaps.
func TestResolveClientIP_TrustToggleConsistency(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	r := newReq("10.0.0.5:1", "8.8.8.8, 10.1.2.3", "")
	for i := 0; i < 5; i++ {
		got := ResolveClientIPString(r, true)
		if got != "8.8.8.8" {
			t.Fatalf("iter %d: want 8.8.8.8 got %s", i, got)
		}
	}
	// Flip trust off — the same request must collapse to RemoteAddr.
	for i := 0; i < 5; i++ {
		got := ResolveClientIPString(r, false)
		if got != "10.0.0.5" {
			t.Fatalf("iter %d (trust=false): want 10.0.0.5 got %s", i, got)
		}
	}
}
