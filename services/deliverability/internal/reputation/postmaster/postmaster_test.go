package postmaster

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

func TestFetchMapsLatestTrafficStats(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/domains/example.com/trafficStats" {
			t.Fatalf("path=%q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"trafficStats": [
				{"startDate": {"year": 2026, "month": 4, "day": 30}, "domainReputation": "LOW"},
				{"startDate": {"year": 2026, "month": 5, "day": 1}, "domainReputation": "HIGH"}
			]
		}`))
	}))
	defer server.Close()

	c := New("token")
	c.BaseURL = server.URL
	c.Now = func() time.Time { return time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC) }

	rep, err := c.Fetch(context.Background(), "example.com", "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotAuth != "Bearer token" {
		t.Fatalf("Authorization=%q", gotAuth)
	}
	if rep.GoogleScore != domain.ReputationHigh {
		t.Fatalf("GoogleScore=%q", rep.GoogleScore)
	}
	if rep.CheckedAt.Year() != 2026 {
		t.Fatalf("CheckedAt=%s", rep.CheckedAt)
	}
}

func TestFetchFallsBackToSpamRate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"trafficStats":[{"userReportedSpamRatio":0.03}]}`))
	}))
	defer server.Close()

	c := New("token")
	c.BaseURL = server.URL
	rep, err := c.Fetch(context.Background(), "example.com", "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if rep.GoogleScore != domain.ReputationLow {
		t.Fatalf("GoogleScore=%q", rep.GoogleScore)
	}
}

func TestFetchErrorsOnEmptyTrafficStats(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"trafficStats":[]}`))
	}))
	defer server.Close()

	c := New("token")
	c.BaseURL = server.URL
	if _, err := c.Fetch(context.Background(), "example.com", ""); err == nil {
		t.Fatal("expected error")
	}
}

func TestFetchCapsSuccessResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(postmasterMaxResponseBytes)+1)))
	}))
	defer server.Close()

	c := New("token")
	c.BaseURL = server.URL
	_, err := c.Fetch(context.Background(), "example.com", "")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Fetch err = %v, want response body too large", err)
	}
}

func TestTrafficStatsURLPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	c := New("token")
	c.BaseURL = "https://postmaster.example.test/proxy/"
	got, err := c.trafficStatsURL("example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://postmaster.example.test/proxy/domains/example.com/trafficStats" {
		t.Fatalf("trafficStatsURL = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@postmaster.example.test",
		"https://postmaster.example.test?token=x",
		"https://postmaster.example.test#frag",
		"file:///tmp/postmaster",
	} {
		c.BaseURL = base
		if _, err := c.trafficStatsURL("example.com"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
}

// TestTrafficStatsURLGuardsItsInputs covers three checks in trafficStatsURL
// that no existing case exercised: removing the domain escaping, the scheme
// allowlist, or the empty-domain rejection each left the package green.
//
// Only the credentials/query/fragment rule was covered. These three matter for
// the same reason it does — trafficStatsURL is the one place a caller-supplied
// value becomes URL structure, and BaseURL is the one place an operator can
// redirect an authenticated request carrying a Bearer token.
func TestTrafficStatsURLGuardsItsInputs(t *testing.T) {
	client := &Client{OAuthToken: "t"}

	t.Run("domain cannot become path structure", func(t *testing.T) {
		// Without url.PathEscape a domain carrying separators rewrites the
		// path: ".../domains/../../v1/other/trafficStats" resolves somewhere
		// this function never intended to address.
		for _, domainName := range []string{"../../v1/other", "a/b", "a?b", "a#b"} {
			got, err := client.trafficStatsURL(domainName)
			if err != nil {
				t.Fatalf("domain %q unexpectedly rejected: %v", domainName, err)
			}
			if strings.Contains(got, "/domains/"+domainName+"/") {
				t.Errorf("domain %q reached the path unescaped: %s", domainName, got)
			}
			if !strings.HasSuffix(got, "/trafficStats") {
				t.Errorf("domain %q broke the path suffix: %s", domainName, got)
			}
		}
		// Guard the guard: an ordinary domain must still read normally.
		got, err := client.trafficStatsURL("example.com")
		if err != nil {
			t.Fatalf("ordinary domain rejected: %v", err)
		}
		if !strings.Contains(got, "/domains/example.com/trafficStats") {
			t.Errorf("ordinary domain was mangled: %s", got)
		}
	})

	t.Run("base URL scheme is allowlisted", func(t *testing.T) {
		// The Bearer token rides on this request, so the scheme decides whether
		// it can leave over something other than HTTP(S).
		for _, base := range []string{"ftp://example.com", "gopher://example.com", "file://host/x"} {
			c := &Client{OAuthToken: "t", BaseURL: base}
			if _, err := c.trafficStatsURL("example.com"); err == nil {
				t.Errorf("scheme accepted for base %q", base)
			}
		}
		for _, base := range []string{"https://gmailpostmastertools.googleapis.com/v1", "http://127.0.0.1:8080"} {
			c := &Client{OAuthToken: "t", BaseURL: base}
			if _, err := c.trafficStatsURL("example.com"); err != nil {
				t.Errorf("supported scheme rejected for base %q: %v", base, err)
			}
		}
	})

	t.Run("empty domain is refused", func(t *testing.T) {
		// Otherwise the path becomes "/domains//trafficStats" and the request
		// is issued against a URL nobody meant to build.
		for _, domainName := range []string{"", "   ", "\t"} {
			if _, err := client.trafficStatsURL(domainName); err == nil {
				t.Errorf("empty domain %q accepted", domainName)
			}
		}
	})
}
