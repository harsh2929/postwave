// SPDX-License-Identifier: AGPL-3.0-only
package prioritization

import "testing"

// TestItoaPriorityBounds verifies the prometheus label encoder pads
// single-digit priorities to two characters so grafana's alphabetical
// label sort matches the numeric ordering, and that out-of-range
// values bucket under "unknown" so the cardinality stays bounded.
func TestItoaPriorityBounds(t *testing.T) {
	tests := []struct {
		in   int
		want string
	}{
		{1, "01"},
		{5, "05"},
		{9, "09"},
		{10, "10"},
		{0, "unknown"},
		{-1, "unknown"},
		{11, "unknown"},
		{99, "unknown"},
	}
	for _, tc := range tests {
		got := itoaPriority(tc.in)
		if got != tc.want {
			t.Errorf("itoaPriority(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestLowercaseAllPreservesCallerSlice guards the doc-stated contract
// that FilterAudience's helper does not mutate the caller's slice.
// The DB ANY()-match needs the lower-cased copy; the caller's slice
// is forwarded to the kept-list and must keep its original casing
// so the send-loop's address-display logic stays accurate.
func TestLowercaseAllPreservesCallerSlice(t *testing.T) {
	src := []string{"Foo@Example.Com", "BAR@example.com"}
	cp := make([]string, len(src))
	copy(cp, src)
	out := lowercaseAll(src)
	for i, s := range src {
		if s != cp[i] {
			t.Errorf("lowercaseAll mutated src[%d]: got %q want %q", i, s, cp[i])
		}
	}
	wantOut := []string{"foo@example.com", "bar@example.com"}
	for i, s := range out {
		if s != wantOut[i] {
			t.Errorf("lowercaseAll out[%d] = %q, want %q", i, s, wantOut[i])
		}
	}
}
