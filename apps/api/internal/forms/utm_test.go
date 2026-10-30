package forms

// Tests for the UTM extractor used by the public submit endpoint.

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestExtractUTMs_AllKeys — every supported attribution key flows
// through to the output map.
func TestExtractUTMs_AllKeys(t *testing.T) {
	q := url.Values{}
	q.Set("utm_source", "newsletter")
	q.Set("utm_medium", "email")
	q.Set("utm_campaign", "spring2026")
	q.Set("utm_term", "growth")
	q.Set("utm_content", "cta-top")
	q.Set("ref", "twitter")
	q.Set("ignored_extra", "junk") // not in utmKeys

	got := ExtractUTMs(q, nil)
	want := map[string]string{
		"utm_source":   "newsletter",
		"utm_medium":   "email",
		"utm_campaign": "spring2026",
		"utm_term":     "growth",
		"utm_content":  "cta-top",
		"ref":          "twitter",
	}
	if len(got) != len(want) {
		t.Fatalf("len(got) = %d, want %d (got = %v)", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("got[%q] = %q, want %q", k, got[k], v)
		}
	}
	if _, ok := got["ignored_extra"]; ok {
		t.Errorf("non-utm key leaked into output: %v", got)
	}
}

// TestExtractUTMs_EmptyResult — no relevant params → empty (not nil)
// map. Empty is the JSON-friendly shape.
func TestExtractUTMs_EmptyResult(t *testing.T) {
	got := ExtractUTMs(url.Values{}, nil)
	if got == nil {
		t.Errorf("got nil, want empty map")
	}
	if len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
}

// TestExtractUTMs_BlankValuesDropped — empty/whitespace values are
// not preserved; treating them as "missing" is the contract.
func TestExtractUTMs_BlankValuesDropped(t *testing.T) {
	q := url.Values{}
	q.Set("utm_source", "")
	q.Set("utm_medium", "   ")
	got := ExtractUTMs(q, nil)
	if len(got) != 0 {
		t.Errorf("blank values should drop, got %v", got)
	}
}

// TestExtractUTMs_BodyFallback — when query is empty but body has
// the key, the body wins. When both are present, query wins.
func TestExtractUTMs_BodyFallback(t *testing.T) {
	got := ExtractUTMs(url.Values{}, map[string]string{"utm_source": "from_body"})
	if got["utm_source"] != "from_body" {
		t.Errorf("body fallback failed: %v", got)
	}

	q := url.Values{}
	q.Set("utm_source", "from_query")
	got = ExtractUTMs(q, map[string]string{"utm_source": "from_body"})
	if got["utm_source"] != "from_query" {
		t.Errorf("query should beat body, got %v", got)
	}
}

// TestExtractUTMs_ClipsLongValues — a 257-char value clips to 256.
// Boundary case: a 256-char value is preserved verbatim.
func TestExtractUTMs_ClipsLongValues(t *testing.T) {
	long := strings.Repeat("x", 257)
	q := url.Values{}
	q.Set("utm_source", long)
	got := ExtractUTMs(q, nil)
	if len(got["utm_source"]) != 256 {
		t.Errorf("clip len = %d, want 256", len(got["utm_source"]))
	}

	right := strings.Repeat("y", 256)
	q = url.Values{}
	q.Set("utm_source", right)
	got = ExtractUTMs(q, nil)
	if got["utm_source"] != right {
		t.Errorf("256-char value should pass through unchanged")
	}
}

// TestExtractUTMs_Trimming — leading/trailing whitespace trimmed.
func TestExtractUTMs_Trimming(t *testing.T) {
	q := url.Values{}
	q.Set("utm_source", "  newsletter  ")
	got := ExtractUTMs(q, nil)
	if got["utm_source"] != "newsletter" {
		t.Errorf("got %q, want trimmed", got["utm_source"])
	}
}

// TestExtractUTMsFromRequest_NilSafe — nil request is allowed, body-
// only path still returns its values.
func TestExtractUTMsFromRequest_NilSafe(t *testing.T) {
	got := ExtractUTMsFromRequest(nil, map[string]string{"utm_medium": "email"})
	if got["utm_medium"] != "email" {
		t.Errorf("got %v, want body-only fallback", got)
	}
}

// TestExtractUTMsFromRequest_URLEncoded — url-encoded values come
// out decoded thanks to net/url's Values handling.
func TestExtractUTMsFromRequest_URLEncoded(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?utm_source=hello%20world&utm_term=q%26a", nil)
	got := ExtractUTMsFromRequest(r, nil)
	if got["utm_source"] != "hello world" {
		t.Errorf("got %q, want decoded", got["utm_source"])
	}
	if got["utm_term"] != "q&a" {
		t.Errorf("got %q, want decoded", got["utm_term"])
	}
}

// TestExtractUTMsFromRequest_DuplicateValuesLastWinsForBody — when a
// body fallback supplies two values, the result is the *first* one
// because url.Values.Get returns index 0. We mirror that: ExtractUTMs
// also calls .Get on the query and the body uses map (single value),
// so this test mostly nails down the docs.
func TestExtractUTMsFromRequest_FirstQueryValueWins(t *testing.T) {
	// `?utm_source=a&utm_source=b` — net/url puts both in Values["utm_source"]
	// but Get() returns the first one. Lock that contract.
	r := httptest.NewRequest("GET", "/x?utm_source=a&utm_source=b", nil)
	got := ExtractUTMsFromRequest(r, nil)
	if got["utm_source"] != "a" {
		t.Errorf("got %q, want first value 'a'", got["utm_source"])
	}
}
