// SPDX-License-Identifier: AGPL-3.0-only

package emailidentity

import (
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"  Ada+News@Example.COM  ", "ada+news@example.com", true},
		{"Name <ada@example.com>", "", false},
		{"\"ada\"@example.com", "", false},
		{"ad\na@example.com", "", false},
		{"ada@example.com\v", "", false},
		{"ada@example.com\f", "", false},
		{"ada@example.com\u0085", "", false},
		{"adà@example.com", "", false},
		{"a@", "", false},
		{"@b.com", "", false},
		{"a@localhost", "", false},
		{"a..b@example.com", "", false},
		{strings.Repeat("a", 65) + "@example.com", "", false},
	}
	for _, tc := range cases {
		got, err := Normalize(tc.in)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("Normalize(%q) = %q, %v; want %q, ok=%v", tc.in, got, err, tc.want, tc.ok)
		}
	}
}

func TestContainsControlCoversDatabaseControlClassBoundary(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f",
	} {
		if !ContainsControl("person@example.com" + raw) {
			t.Errorf("ContainsControl did not reject %q", raw)
		}
	}
	for _, raw := range []string{" person@example.com ", "person+顧客@example.com", ""} {
		if ContainsControl(raw) {
			t.Errorf("ContainsControl rejected non-control input %q", raw)
		}
	}
}
