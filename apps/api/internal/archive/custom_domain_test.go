// SPDX-License-Identifier: AGPL-3.0-only
//
// custom_domain_test.go — unit tests for the archive-custom-domain-honor
// gap-feature surface. Covers the pure-Go helpers (no DB):
//
//   - ValidateArchiveDomain: shape + reserved-suffix gates.
//   - normaliseHost: port-strip + www. trim + lowercase + trailing dot.
//   - customDomainTarget: env-var override + default fallback.
//
// Integration paths (TenantByHost / MarkVerification / Mount middleware)
// require a real DB and are exercised in the live route tests under
// `apps/api/cmd/postwave-verify`. This file is the unit-test half — it
// runs in `go test ./internal/archive/...` without any infra.

package archive

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestValidateArchiveDomain covers every branch of the validator:
// the empty-input (clears the column) happy path, the shape gates
// (length, regex), and the reserved-suffix gate that blocks tenants
// from claiming a Moosewave edge host. Mirrors the assertion list the
// audit register lists under "archive-custom-domain-honor".
func TestValidateArchiveDomain(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		input   string
		wantErr error
	}{
		{"empty allowed (clears column)", "", nil},
		{"whitespace trimmed", "   ", nil},
		{"happy path lowercased", "archive.example.com", nil},
		{"happy path multi-label", "news.foo.example.co.uk", nil},
		{"accepts uppercase (lowercased internally)", "Archive.Example.COM", nil},
		{"rejects port", "archive.example.com:8080", ErrInvalidDomain},
		{"rejects scheme", "https://archive.example.com", ErrInvalidDomain},
		{"rejects single-label", "localhost", ErrInvalidDomain},
		{"rejects trailing dot", "archive.example.com.", ErrInvalidDomain},
		{"rejects leading hyphen", "-archive.example.com", ErrInvalidDomain},
		{"rejects trailing hyphen", "archive-.example.com", ErrInvalidDomain},
		{"rejects too-long label", strings.Repeat("a", 254) + ".com", ErrInvalidDomain},
		{"reserved moosewave.com", "archive.moosewave.com", ErrReservedDomain},
		{"reserved moosewave.com", "news.moosewave.com", ErrReservedDomain},
		{"reserved postwave.dev", "archive.postwave.dev", ErrReservedDomain},
		{"reserved postwave.io", "archive.postwave.io", ErrReservedDomain},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ValidateArchiveDomain(tc.input)
			if tc.wantErr == nil {
				if got != nil {
					t.Fatalf("ValidateArchiveDomain(%q) = %v; want nil", tc.input, got)
				}
				return
			}
			if got != tc.wantErr {
				t.Fatalf("ValidateArchiveDomain(%q) = %v; want %v", tc.input, got, tc.wantErr)
			}
		})
	}
}

// TestNormaliseHost validates the host-string canonicalisation that
// `TenantByHost` and the middleware rely on. Inbound Host headers can
// contain ports, casing, www prefixes, and trailing dots — all four
// must collapse to the same canonical form the DB stores in citext.
func TestNormaliseHost(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"whitespace-only", "   ", ""},
		{"plain", "archive.example.com", "archive.example.com"},
		{"strips port", "archive.example.com:8080", "archive.example.com"},
		{"strips TLS port", "archive.example.com:443", "archive.example.com"},
		{"lowercases", "Archive.Example.COM", "archive.example.com"},
		{"strips trailing dot", "archive.example.com.", "archive.example.com"},
		{"strips www", "www.example.com", "example.com"},
		{"strips www + port + dot", "WWW.Example.com.:443", "example.com"},
		{"rejects empty port", "archive.example.com:", ""},
		{"rejects nonnumeric port", "archive.example.com:notaport", ""},
		{"rejects out-of-range port", "archive.example.com:65536", ""},
		{"rejects userinfo-like host", "archive.example.com@evil.example", ""},
		{"rejects suffix after port", "archive.example.com:443@evil.example", ""},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := normaliseHost(tc.input)
			if got != tc.want {
				t.Fatalf("normaliseHost(%q) = %q; want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestCustomDomainArchivePathUsesMountedNewsletterFeedRoutes(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"/":                                 "/api/public/archive/acme",
		"/welcome":                          "/api/public/archive/acme/welcome",
		"/welcome/pixel.gif":                "/api/public/archive/acme/welcome/pixel.gif",
		"/sitemap.xml":                      "/api/public/archive/acme/sitemap.xml",
		"/sitemap-2.xml":                    "/api/public/archive/acme/sitemap-2.xml",
		"/feed.xml":                         "/api/public/archive/acme/feed.xml",
		"/rss.xml":                          "/api/public/archive/acme/feed.xml",
		"/feed.json":                        "/api/public/archive/acme/feed.json",
		"/tag/release-notes/feed.xml":       "/api/public/archive/acme/tag/release-notes/feed.xml",
		"/author/jane-doe/feed.json":        "/api/public/archive/acme/author/jane-doe/feed.json",
		"/api/public/archive/acme/feed.xml": "/api/public/archive/acme/feed.xml",
	}
	for input, want := range cases {
		input, want := input, want
		t.Run(input, func(t *testing.T) {
			t.Parallel()
			if got := customDomainArchivePath(input, "acme"); got != want {
				t.Fatalf("customDomainArchivePath(%q) = %q, want %q", input, got, want)
			}
		})
	}
}

func TestVerifiedCustomDomainHostCannotBeSpoofedByPublicHeader(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest("GET", "https://archive.example/feed.xml", nil)
	req.Header.Set("X-Postwave-Custom-Domain", "attacker.example")
	if host, ok := VerifiedCustomDomainHost(req.Context()); ok || host != "" {
		t.Fatalf("public header forged verified context: host=%q ok=%v", host, ok)
	}

	ctx := context.WithValue(req.Context(), verifiedCustomDomainHostContextKey{}, "news.example.com")
	if host, ok := VerifiedCustomDomainHost(ctx); !ok || host != "news.example.com" {
		t.Fatalf("verified middleware context not recovered: host=%q ok=%v", host, ok)
	}
}

func TestCustomDomainMiddlewareStripsSpoofedHeaderOnHostedOrigin(t *testing.T) {
	t.Parallel()
	deps := &Deps{}
	var observedHeader string
	var observedVerified bool
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		observedHeader = r.Header.Get("X-Postwave-Custom-Domain")
		_, observedVerified = VerifiedCustomDomainHost(r.Context())
	})
	handler := deps.CustomDomainMiddleware(CustomDomainConfig{
		SkipHosts: []string{"archive.example.com"},
	})(next)
	req := httptest.NewRequest("GET", "https://archive.example.com/feed.xml", nil)
	req.Header.Set("X-Postwave-Custom-Domain", "attacker.example")
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if observedHeader != "" || observedVerified {
		t.Fatalf("spoofed custom-domain identity propagated: header=%q verified=%v", observedHeader, observedVerified)
	}
}

func TestVerifiedInboundDomainHostRetainsTruthfulWWWOrigin(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		inbound, lookup, want string
	}{
		{"WWW.Example.com:443", "example.com", "www.example.com"},
		{"news.example.com.", "news.example.com", "news.example.com"},
		{"news.example.com:notaport", "news.example.com", "news.example.com"},
		{"user:pass@evil.example", "news.example.com", "news.example.com"},
	} {
		if got := verifiedInboundDomainHost(tc.inbound, tc.lookup); got != tc.want {
			t.Errorf("verifiedInboundDomainHost(%q, %q) = %q, want %q", tc.inbound, tc.lookup, got, tc.want)
		}
	}
}

// TestCustomDomainTarget verifies the env-var override path used by
// staging / self-hosted deployments runs their edge on a non-canonical
// host. We restore the original getEnvFunc after the test so package
// state stays clean for the rest of the suite.
func TestCustomDomainTarget(t *testing.T) {
	orig := getEnvFunc
	t.Cleanup(func() { getEnvFunc = orig })

	t.Run("defaults when env unset", func(t *testing.T) {
		getEnvFunc = func(string) string { return "" }
		if got := customDomainTarget(); got != DefaultCNAMETarget {
			t.Fatalf("customDomainTarget() = %q; want %q", got, DefaultCNAMETarget)
		}
	})
	t.Run("env override wins", func(t *testing.T) {
		getEnvFunc = func(k string) string {
			if k == "ARCHIVE_CUSTOM_DOMAIN_TARGET" {
				return "edge.staging.example.com"
			}
			return ""
		}
		if got := customDomainTarget(); got != "edge.staging.example.com" {
			t.Fatalf("customDomainTarget() override = %q; want %q",
				got, "edge.staging.example.com")
		}
	})
	t.Run("env override trims whitespace", func(t *testing.T) {
		getEnvFunc = func(k string) string {
			if k == "ARCHIVE_CUSTOM_DOMAIN_TARGET" {
				return "   edge.example.com   "
			}
			return ""
		}
		if got := customDomainTarget(); got != "edge.example.com" {
			t.Fatalf("customDomainTarget() trimmed = %q; want %q",
				got, "edge.example.com")
		}
	})
	t.Run("whitespace-only env falls back to default", func(t *testing.T) {
		getEnvFunc = func(k string) string {
			if k == "ARCHIVE_CUSTOM_DOMAIN_TARGET" {
				return "   "
			}
			return ""
		}
		if got := customDomainTarget(); got != DefaultCNAMETarget {
			t.Fatalf("customDomainTarget() whitespace-only = %q; want %q",
				got, DefaultCNAMETarget)
		}
	})
}

// TestVerificationStatusConstants pins the wire-enum values that the
// desktop UI switches on. If anyone renames these the desktop's
// "pending / verified / failed" badges silently break, so the test
// fails the refactor at compile time.
func TestVerificationStatusConstants(t *testing.T) {
	t.Parallel()
	cases := []struct {
		got, want string
	}{
		{string(VerificationPending), "pending"},
		{string(VerificationVerified), "verified"},
		{string(VerificationFailed), "failed"},
		{string(SSLPending), "pending"},
		{string(SSLIssuing), "issuing"},
		{string(SSLIssued), "issued"},
		{string(SSLFailed), "failed"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Fatalf("wire enum drift: got %q want %q", tc.got, tc.want)
		}
	}
}

// TestDefaultCNAMETarget pins the canonical instruction string the
// dashboard renders under "Add this CNAME → ...". Changing the host
// requires a coordinated edge-config update; the test prevents an
// accidental rename slipping through code review.
func TestDefaultCNAMETarget(t *testing.T) {
	t.Parallel()
	if DefaultCNAMETarget != "custom-domains.moosewave.com" {
		t.Fatalf("DefaultCNAMETarget = %q; expected canonical instruction host",
			DefaultCNAMETarget)
	}
}
