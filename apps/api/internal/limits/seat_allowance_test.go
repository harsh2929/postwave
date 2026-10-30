// SPDX-License-Identifier: AGPL-3.0-only
package limits

import "testing"

func TestWorkspaceSeatAllowance(t *testing.T) {
	tests := []struct {
		raw       string
		canonical string
		allowance int
	}{
		{raw: "sandbox", canonical: "sandbox", allowance: 1},
		{raw: "studio", canonical: "studio", allowance: 1},
		{raw: "launch", canonical: "launch", allowance: 3},
		{raw: "growth", canonical: "growth", allowance: 5},
		{raw: "scale", canonical: "scale", allowance: 10},
		{raw: "sending", canonical: "launch", allowance: 3},
		{raw: "PRO", canonical: "scale", allowance: 10},
		{raw: "unknown", canonical: "sandbox", allowance: 1},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			canonical, allowance := WorkspaceSeatAllowance(tt.raw)
			if canonical != tt.canonical || allowance != tt.allowance {
				t.Fatalf("WorkspaceSeatAllowance(%q) = %q/%d, want %q/%d",
					tt.raw, canonical, allowance, tt.canonical, tt.allowance)
			}
		})
	}
}
