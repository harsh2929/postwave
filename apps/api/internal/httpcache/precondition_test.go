// SPDX-License-Identifier: AGPL-3.0-only

package httpcache

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func reqIfMatch(v string) *http.Request {
	r := httptest.NewRequest(http.MethodPatch, "/x", nil)
	if v != "" {
		r.Header.Set("If-Match", v)
	}
	return r
}

func TestParseIfMatch(t *testing.T) {
	cases := []struct {
		hdr      string
		token    string
		present  bool
		wildcard bool
	}{
		{"", "", false, false},
		{"*", "", true, true},
		{`"campaign:abc:v17"`, `"campaign:abc:v17"`, true, false},
		{`W/"campaign:abc:v17"`, `W/"campaign:abc:v17"`, true, false},
		{`"a", "b"`, `"a", "b"`, true, false},
	}
	for _, c := range cases {
		tok, present, wild := ParseIfMatch(reqIfMatch(c.hdr))
		if tok != c.token || present != c.present || wild != c.wildcard {
			t.Errorf("ParseIfMatch(%q) = (%q,%v,%v) want (%q,%v,%v)",
				c.hdr, tok, present, wild, c.token, c.present, c.wildcard)
		}
	}
}

func TestIfMatchFailed(t *testing.T) {
	cur := ConcurrencyToken("campaign", "abc", time.Unix(0, 17000).UTC())
	// No header → never fails (legacy unconditional write).
	if IfMatchFailed(reqIfMatch(""), cur) {
		t.Error("no If-Match must not fail")
	}
	// Matching token → passes.
	if IfMatchFailed(reqIfMatch(cur), cur) {
		t.Error("matching token must pass")
	}
	// RFC 7232 requires strong comparison for If-Match. A weak validator cannot
	// authorize a write even when its opaque value matches.
	if !IfMatchFailed(reqIfMatch("W/"+cur), cur) {
		t.Error("weak-prefixed matching token must fail")
	}
	// Exact-token callers must not truncate a list into an accidental match.
	if !IfMatchFailed(reqIfMatch(cur+`, "stale"`), cur) {
		t.Error("multi-value If-Match must fail exact-token comparison")
	}
	// Stale token → fails.
	stale := ConcurrencyToken("campaign", "abc", time.Unix(0, 9000).UTC())
	if !IfMatchFailed(reqIfMatch(stale), cur) {
		t.Error("stale token must fail")
	}
	// Wildcard against existing row → passes; against missing → fails.
	if IfMatchFailed(reqIfMatch("*"), cur) {
		t.Error("wildcard against existing row must pass")
	}
	if !IfMatchFailed(reqIfMatch("*"), "") {
		t.Error("wildcard against missing row must fail")
	}
}

func TestConcurrencyTokenStable(t *testing.T) {
	ts := time.Unix(1700000000, 123456000).UTC()
	a := ConcurrencyToken("campaign", "id1", ts)
	b := ConcurrencyToken("campaign", "id1", ts)
	if a != b {
		t.Fatalf("token not stable: %q vs %q", a, b)
	}
	if a == ConcurrencyToken("campaign", "id1", ts.Add(time.Microsecond)) {
		t.Fatal("token must change when updated_at advances")
	}
}

func TestPreconditionWriters(t *testing.T) {
	required := httptest.NewRecorder()
	WritePreconditionRequired(required)
	if required.Code != http.StatusPreconditionRequired ||
		required.Header().Get("Content-Type") != "application/json" ||
		!strings.Contains(required.Body.String(), `"code":"precondition_required"`) {
		t.Fatalf("required response = %d %q %s", required.Code,
			required.Header().Get("Content-Type"), required.Body.String())
	}

	failed := httptest.NewRecorder()
	WritePreconditionFailed(failed)
	if failed.Code != http.StatusPreconditionFailed ||
		!strings.Contains(failed.Body.String(), `"code":"precondition_failed"`) {
		t.Fatalf("failed response = %d %s", failed.Code, failed.Body.String())
	}
}
