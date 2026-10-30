// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import "testing"

// TestNormalizePriorityContract pins the priority-input normaliser to
// the contract its callers depend on: zero (omit-empty JSON) maps to
// PriorityDefault, out-of-range values clamp to the legal bounds, and
// in-range values pass through. Keeps the DB CHECK + this helper in
// lockstep — a regression here would let the INSERT/UPDATE pass an
// illegal value and the DB would reject the whole transaction.
func TestNormalizePriorityContract(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"zero falls back to default", 0, PriorityDefault},
		{"negative clamps to min", -10, PriorityMin},
		{"one passes through", 1, 1},
		{"five passes through", 5, 5},
		{"ten passes through", 10, 10},
		{"eleven clamps to max", 11, PriorityMax},
		{"hundred clamps to max", 100, PriorityMax},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizePriority(tc.in)
			if got != tc.want {
				t.Fatalf("NormalizePriority(%d) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// TestPriorityConstantInvariants documents the contract between this
// package and the migration / DB CHECK constraint. If anyone bumps
// PriorityMax above 10 without also updating
// 0298_campaigns_priority.sql's CHECK clause, this test trips so the
// drift gets caught before it reaches the DB.
func TestPriorityConstantInvariants(t *testing.T) {
	if PriorityMin != 1 {
		t.Errorf("PriorityMin = %d, want 1 (matches migration 0298 CHECK)", PriorityMin)
	}
	if PriorityMax != 10 {
		t.Errorf("PriorityMax = %d, want 10 (matches migration 0298 CHECK)", PriorityMax)
	}
	if PriorityDefault < PriorityMin || PriorityDefault > PriorityMax {
		t.Errorf("PriorityDefault = %d outside legal range [%d..%d]", PriorityDefault, PriorityMin, PriorityMax)
	}
	if PriorityTransactional != PriorityMax {
		t.Errorf("PriorityTransactional = %d, want PriorityMax (%d) — transactional should be the highest valid priority", PriorityTransactional, PriorityMax)
	}
}
