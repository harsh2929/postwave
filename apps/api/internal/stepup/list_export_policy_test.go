// SPDX-License-Identifier: AGPL-3.0-only

package stepup

import "testing"

// The subscribers export was gated and capped; the per-list export was neither.
// List ids come back from GET /api/v1/lists, which any viewer may call, so a
// borrowed post-MFA session could walk the lists and stream the complete
// membership of each — every address, status and acquisition source — without
// ever being challenged. Both exports take the same PII off the platform, so
// both are Immediate-tier.
func TestListMemberExportRequiresImmediateStepUp(t *testing.T) {
	t.Parallel()

	req := Match("GET", "/api/v1/lists/7f2b1c94-0000-4000-8000-000000000001/export.csv")
	if !req.Required() {
		t.Fatal("GET /api/v1/lists/{id}/export.csv is not step-up gated")
	}
	if req.MaxAge != Immediate {
		t.Fatalf("MaxAge = %v, want Immediate — same tier as the subscribers export", req.MaxAge)
	}
	if req.Action != "list.export" {
		t.Fatalf("Action = %q, want list.export", req.Action)
	}

	// Sanity: the sibling it was compared against is still gated, so a future
	// change that loosens both does not pass this test by symmetry.
	if sub := Match("GET", "/api/v1/subscribers/export.csv"); sub.MaxAge != Immediate {
		t.Fatalf("subscribers export MaxAge = %v, want Immediate", sub.MaxAge)
	}
}
