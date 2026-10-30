// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"math"
	"testing"
	"time"
)

func day(y, m, d int) time.Time {
	return time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
}

// TestComputeCadence_EvenSpacing verifies the average is the mean inter-order
// gap and the expected-next projection is last + average.
func TestComputeCadence_EvenSpacing(t *testing.T) {
	// Orders 10 days apart: 1st, 11th, 21st → 2 gaps of 10 days → avg 10.
	orders := []time.Time{day(2026, 1, 1), day(2026, 1, 11), day(2026, 1, 21)}
	cad := computeCadence(orders)
	if !cad.Valid {
		t.Fatal("cadence should be valid for 3 orders")
	}
	if math.Abs(cad.AverageDays-10.0) > 1e-9 {
		t.Errorf("AverageDays = %v, want 10", cad.AverageDays)
	}
	if !cad.LastOrderAt.Equal(day(2026, 1, 21)) {
		t.Errorf("LastOrderAt = %v, want 2026-01-21", cad.LastOrderAt)
	}
	wantNext := day(2026, 1, 31)
	if !cad.ExpectedNextOrderAt.Equal(wantNext) {
		t.Errorf("ExpectedNextOrderAt = %v, want %v", cad.ExpectedNextOrderAt, wantNext)
	}
	if cad.OrderCount != 3 {
		t.Errorf("OrderCount = %d, want 3", cad.OrderCount)
	}
}

// TestComputeCadence_UnevenSpacing checks the mean over uneven gaps uses the
// total span / gap count (not a per-gap average that ignores magnitude).
func TestComputeCadence_UnevenSpacing(t *testing.T) {
	// Gaps of 5 and 15 days → total span 20 over 2 gaps → avg 10.
	orders := []time.Time{day(2026, 3, 1), day(2026, 3, 6), day(2026, 3, 21)}
	cad := computeCadence(orders)
	if !cad.Valid || math.Abs(cad.AverageDays-10.0) > 1e-9 {
		t.Fatalf("AverageDays = %v (valid=%v), want 10", cad.AverageDays, cad.Valid)
	}
}

// TestComputeCadence_Unsorted verifies the input is sorted internally so an
// out-of-order order slice yields the same cadence.
func TestComputeCadence_Unsorted(t *testing.T) {
	orders := []time.Time{day(2026, 1, 21), day(2026, 1, 1), day(2026, 1, 11)}
	cad := computeCadence(orders)
	if !cad.Valid || math.Abs(cad.AverageDays-10.0) > 1e-9 {
		t.Fatalf("AverageDays = %v, want 10 (sorted internally)", cad.AverageDays)
	}
	if !cad.LastOrderAt.Equal(day(2026, 1, 21)) {
		t.Errorf("LastOrderAt = %v, want latest 2026-01-21", cad.LastOrderAt)
	}
}

// TestComputeCadence_SingleOrder — one order cannot yield a cadence; Valid is
// false but the LastOrderAt anchor is still captured.
func TestComputeCadence_SingleOrder(t *testing.T) {
	cad := computeCadence([]time.Time{day(2026, 1, 1)})
	if cad.Valid {
		t.Error("single order must not be a valid cadence")
	}
	if !cad.LastOrderAt.Equal(day(2026, 1, 1)) {
		t.Errorf("LastOrderAt = %v, want 2026-01-01", cad.LastOrderAt)
	}
	if cad.OrderCount != 1 {
		t.Errorf("OrderCount = %d, want 1", cad.OrderCount)
	}
}

// TestComputeCadence_NoOrders — zero orders is an invalid, empty cadence.
func TestComputeCadence_NoOrders(t *testing.T) {
	cad := computeCadence(nil)
	if cad.Valid || cad.OrderCount != 0 {
		t.Errorf("empty cadence = %+v, want invalid/zero", cad)
	}
}

// TestComputeCadence_SameInstant — multiple orders at the same instant have no
// measurable span, so the cadence is invalid.
func TestComputeCadence_SameInstant(t *testing.T) {
	at := day(2026, 1, 1)
	cad := computeCadence([]time.Time{at, at, at})
	if cad.Valid {
		t.Error("zero-span order history must not be a valid cadence")
	}
	if !cad.LastOrderAt.Equal(at) {
		t.Errorf("LastOrderAt = %v, want %v", cad.LastOrderAt, at)
	}
}

// TestJSONHelpers verifies the jsonb literal encoders the upsert uses.
func TestJSONHelpers(t *testing.T) {
	if got := jsonNumber(10.5); got != "10.5" {
		t.Errorf("jsonNumber(10.5) = %q, want 10.5", got)
	}
	if got := jsonString("2026-01-01T00:00:00Z"); got != `"2026-01-01T00:00:00Z"` {
		t.Errorf("jsonString = %q", got)
	}
}

// TestCadenceListener_NilSafe — a nil listener Trigger/Wait must be a no-op,
// and a nil-repo Repo.triggerCadenceBackfill must not panic.
func TestCadenceListener_NilSafe(t *testing.T) {
	var l *CadenceBackfillListener
	l.Trigger("t1", time.Time{}) // must not panic
	l.Wait()

	r := &Repo{} // CadenceBackfill nil
	r.triggerCadenceBackfill("t1")
}
