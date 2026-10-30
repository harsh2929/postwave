// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure (no-DB) tests for the last-touch attribution constants +
// provenance values. These guard the contract that migration 0397's
// CHECK constraint depends on.
package conversions

import "testing"

// TestAttributedViaConstants pins the three provenance strings — they
// MUST exactly match the CHECK (attributed_via IN (...)) in migration
// 0397. Changing one here without the migration (or vice versa) breaks
// ingestion at the DB layer.
func TestAttributedViaConstants(t *testing.T) {
	cases := map[string]string{
		AttributedViaExplicit:  "explicit",
		AttributedViaLastTouch: "last_touch",
		AttributedViaNone:      "none",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("provenance constant = %q, want %q", got, want)
		}
	}
}

// TestLastTouchWindowIsSevenDays documents + pins the attribution
// window. 0397's schema comment references 7 days; this keeps the code
// and the comment honest.
func TestLastTouchWindowIsSevenDays(t *testing.T) {
	const sevenDaysHours = 7 * 24
	if h := lastTouchAttributionWindow.Hours(); h != sevenDaysHours {
		t.Errorf("lastTouchAttributionWindow = %vh, want %dh (7 days)", h, sevenDaysHours)
	}
}

// TestBackfillBatchSizeBounded sanity-checks the batch bound is a
// positive, non-trivial value so the backfill always makes progress and
// never holds an unbounded transaction.
func TestBackfillBatchSizeBounded(t *testing.T) {
	if backfillBatchSize <= 0 || backfillBatchSize > 10000 {
		t.Errorf("backfillBatchSize = %d, want a bounded positive batch", backfillBatchSize)
	}
}
