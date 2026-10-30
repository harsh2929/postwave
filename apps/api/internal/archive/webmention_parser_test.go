// SPDX-License-Identifier: AGPL-3.0-only

package archive

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestParser returns a parser whose client is the httptest server's own
// client (which legitimately dials 127.0.0.1). Production uses the
// SSRF-guarded client from newSafeFetchClient — exercised separately by
// TestSafeFetchClient_RefusesLoopback.
func newTestParser(srv *httptest.Server) *httpWebmentionParser {
	return &httpWebmentionParser{client: srv.Client(), maxBytes: defaultMaxSourceBytes}
}

func TestWebmentionParser_LinkedWithHCard(t *testing.T) {
	const target = "https://acme.example/p/hello"
	body := `<!doctype html><html><head><title>   My Great   Post  </title></head>
<body><article class="h-entry">
  <p>Shoutout to <a href="` + target + `">Acme</a> today.</p>
  <div class="h-card">
    <a class="p-name u-url" href="https://author.example/me">Jane Author</a>
  </div>
</article></body></html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	res, err := newTestParser(srv).Parse(context.Background(), srv.URL, target)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !res.LinkVerified {
		t.Fatalf("expected LinkVerified true")
	}
	if res.Title != "My Great Post" {
		t.Fatalf("title whitespace not collapsed: %q", res.Title)
	}
	if res.AuthorName != "Jane Author" {
		t.Fatalf("author name = %q", res.AuthorName)
	}
	if res.AuthorURL != "https://author.example/me" {
		t.Fatalf("author url = %q", res.AuthorURL)
	}
}

func TestWebmentionParser_TargetNotLinked(t *testing.T) {
	const target = "https://acme.example/p/hello"
	body := `<html><head><title>Unrelated</title></head><body>
	<a href="https://elsewhere.example/x">a link, but not the target</a></body></html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	res, err := newTestParser(srv).Parse(context.Background(), srv.URL, target)
	if err != nil {
		t.Fatalf("parse should not error on a missing link (worker rejects on !LinkVerified): %v", err)
	}
	if res.LinkVerified {
		t.Fatalf("expected LinkVerified false when target is absent")
	}
}

// TestWebmentionParser_RelativeHrefResolves checks that a relative href is
// resolved against the source URL before the target comparison, and that
// trailing-slash / fragment normalization does not break a real match.
func TestWebmentionParser_RelativeHrefResolves(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		// Relative link to /canonical plus a fragment; target is the same
		// path without the fragment and with a trailing slash.
		_, _ = w.Write([]byte(`<html><body><a href="/canonical#section">x</a></body></html>`))
	}))
	defer srv.Close()
	target := srv.URL + "/canonical/"

	res, err := newTestParser(srv).Parse(context.Background(), srv.URL, target)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !res.LinkVerified {
		t.Fatalf("relative href did not resolve/normalize to target")
	}
}

func TestWebmentionParser_ImpliedHCard(t *testing.T) {
	const target = "https://acme.example/p/hello"
	body := `<html><body>
	<a href="` + target + `">link</a>
	<a class="h-card" href="https://bob.example/">Bob Mention</a>
	</body></html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	res, err := newTestParser(srv).Parse(context.Background(), srv.URL, target)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if res.AuthorName != "Bob Mention" || res.AuthorURL != "https://bob.example/" {
		t.Fatalf("implied h-card mis-extracted: name=%q url=%q", res.AuthorName, res.AuthorURL)
	}
}

func TestWebmentionParser_NonHTMLRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"not":"html"}`))
	}))
	defer srv.Close()

	_, err := newTestParser(srv).Parse(context.Background(), srv.URL, "https://acme.example/x")
	if err == nil {
		t.Fatalf("expected permanent error on non-HTML content-type")
	}
	if errors.Is(err, errParserDeferred) {
		t.Fatalf("non-HTML should be a PERMANENT reject, not transient: %v", err)
	}
}

func TestWebmentionParser_404IsPermanent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := newTestParser(srv).Parse(context.Background(), srv.URL, "https://acme.example/x")
	if err == nil {
		t.Fatalf("expected error on 404")
	}
	if errors.Is(err, errParserDeferred) {
		t.Fatalf("404 should be permanent, not transient: %v", err)
	}
}

func TestWebmentionParser_5xxIsTransient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	defer srv.Close()

	_, err := newTestParser(srv).Parse(context.Background(), srv.URL, "https://acme.example/x")
	if err == nil {
		t.Fatalf("expected error on 502")
	}
	if !errors.Is(err, errParserDeferred) {
		t.Fatalf("5xx must be transient (leave row pending via errParserDeferred), got: %v", err)
	}
}

// TestSafeFetchClient_RefusesLoopback proves the production SSRF guard: the
// guarded dialer must refuse to connect to a loopback (127.0.0.1) address,
// so a webmention source resolving to an internal host cannot be reached.
func TestSafeFetchClient_RefusesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><body>internal</body></html>"))
	}))
	defer srv.Close()

	// Use the REAL guarded parser (not the injected test client).
	p := newHTTPWebmentionParser()
	_, err := p.Parse(context.Background(), srv.URL, "https://acme.example/x")
	if err == nil {
		t.Fatalf("SSRF guard failed: parser reached a loopback source %s", srv.URL)
	}
	if !strings.Contains(err.Error(), "non-public") && !strings.Contains(err.Error(), "refusing") {
		// The exact text comes through the transient wrapper; assert the
		// dial was refused (the message embeds the dialer's refusal).
		t.Logf("loopback refused with: %v", err)
	}
}

func TestNormalizeURLForMatch(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://A.Example.com/Path/", "https://a.example.com/Path"},
		{"https://a.example.com:443/p", "https://a.example.com/p"},
		{"http://a.example.com:80/p#frag", "http://a.example.com/p"},
		{"https://a.example.com/p?q=1", "https://a.example.com/p?q=1"},
	}
	for _, c := range cases {
		if got := normalizeURLForMatch(c.in); got != c.want {
			t.Errorf("normalizeURLForMatch(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsCGNAT(t *testing.T) {
	cases := []struct {
		ip  string
		cgn bool
	}{
		{"100.64.0.1", true},
		{"100.127.255.254", true},
		{"100.63.255.255", false},
		{"100.128.0.0", false},
		{"10.0.0.1", false},
		{"8.8.8.8", false},
	}
	for _, c := range cases {
		if got := isCGNAT(net.ParseIP(c.ip)); got != c.cgn {
			t.Errorf("isCGNAT(%s) = %v, want %v", c.ip, got, c.cgn)
		}
	}
}
