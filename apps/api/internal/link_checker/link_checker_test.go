package link_checker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExtractURLs_DedupesAndSkipsRelative(t *testing.T) {
	body := `
<html><body>
  <a href="https://a.example/one">one</a>
  <a href='https://b.example/two'>two</a>
  <a href="https://a.example/one">dup</a>
  <a href="/relative">skip</a>
  <a href="mailto:hi@x.com">also skip</a>
</body></html>`
	got := ExtractURLs(body)
	if len(got) != 2 {
		t.Fatalf("want 2 urls, got %d (%v)", len(got), got)
	}
	if got[0] != "https://a.example/one" || got[1] != "https://b.example/two" {
		t.Fatalf("order wrong: %v", got)
	}
}

func TestExtractURLs_Empty(t *testing.T) {
	if got := ExtractURLs(""); len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}

func TestCheck_LiveServer(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	defer ok.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(404)
	}))
	defer bad.Close()
	// Inject a plain http.Client because the secure default (production
	// path) blocks 127.0.0.1 destinations — which is correct for live
	// traffic but defeats httptest's local-loopback server. Tests that
	// need to round-trip a real HTTP exchange opt in to the bare
	// client via opts.Client; production callers omit it and get the
	// SSRF-safe default.
	results := Check(context.Background(), []string{ok.URL, bad.URL}, CheckOptions{Client: &http.Client{}})
	if len(results) != 2 {
		t.Fatalf("want 2 results")
	}
	if !results[0].OK || results[0].Status != 200 {
		t.Fatalf("good url: %#v", results[0])
	}
	if results[1].OK || results[1].Status != 404 {
		t.Fatalf("bad url: %#v", results[1])
	}
}
