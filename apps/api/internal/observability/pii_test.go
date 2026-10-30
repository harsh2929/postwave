// SPDX-License-Identifier: AGPL-3.0-only

package observability

import (
	"strings"
	"testing"
)

func TestRedactEmail(t *testing.T) {
	if got := RedactEmail(""); got != "" {
		t.Errorf("empty input: got %q want \"\"", got)
	}
	// Normal address: 10-char hex prefix + "@" + domain.
	got := RedactEmail("alice@example.com")
	if !strings.HasSuffix(got, "@example.com") {
		t.Errorf("domain stripped: got %q", got)
	}
	if len(got) != 10+len("@example.com") {
		t.Errorf("unexpected length: got %q len=%d", got, len(got))
	}
	if strings.Contains(got, "alice") {
		t.Errorf("local-part leaked: got %q", got)
	}
	// Case + whitespace normalisation: trimmed + lowercased input
	// hashes to the same value as the plain form.
	if RedactEmail("  Alice@Example.COM  ") != RedactEmail("alice@example.com") {
		t.Errorf("normalisation broken")
	}
	// Malformed (no @ or trailing @) → just the 10-char prefix, no "@".
	for _, bad := range []string{"no-at-sign", "user@"} {
		out := RedactEmail(bad)
		if len(out) != 10 || strings.Contains(out, "@") {
			t.Errorf("malformed %q: got %q want 10-char prefix only", bad, out)
		}
	}
}

func TestRedactEmail_Stable(t *testing.T) {
	// Same input → same output across calls. Needed for log-grep
	// correlation: two log lines about the same subscriber must hash
	// to the same redacted value.
	a := RedactEmail("alice@example.com")
	b := RedactEmail("alice@example.com")
	if a != b {
		t.Errorf("not stable: %q vs %q", a, b)
	}
	// Different addresses must produce different redactions
	// (collision rate is ~2^-40 over 5 bytes of SHA-256, plenty).
	if RedactEmail("alice@example.com") == RedactEmail("bob@example.com") {
		t.Errorf("hash collision between distinct addresses")
	}
}

func TestRedactIP(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"not-an-ip", ""},
		{"203.0.113.42", "203.0.113.0/24"},
		{"2001:db8::1", "2001:db8::/48"},
	}
	for _, c := range cases {
		if got := RedactIP(c.in); got != c.want {
			t.Errorf("RedactIP(%q) = %q want %q", c.in, got, c.want)
		}
	}
}
