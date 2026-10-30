// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"testing"
	"time"
)

// first_red_at must survive subsequent red observations, or the board can
// never say "red for 19 hours" — and "how long has this been broken" is the
// first question anyone asks.
func TestUpsert_FirstRedAtIsStickyAcrossReds(t *testing.T) {
	pool := testPool(t)
	truncate(t, pool, "ops_check_results", "ops_check_history")
	s := NewStore(pool)
	ctx := context.Background()

	t0 := time.Now().UTC().Truncate(time.Second)

	if err := s.Upsert(ctx, "t.sticky", Result{}, StatusRed, "first", t0); err != nil {
		t.Fatal(err)
	}
	all, err := s.LoadAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first := all["t.sticky"]
	if first.FirstRedAt == nil {
		t.Fatal("first red observation must set first_red_at")
	}

	if err := s.Upsert(ctx, "t.sticky", first, StatusRed, "still", t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	all, _ = s.LoadAll(ctx)
	if !all["t.sticky"].FirstRedAt.Equal(*first.FirstRedAt) {
		t.Fatal("first_red_at must not move while the check stays red")
	}

	// Recovering clears it.
	if err := s.Upsert(ctx, "t.sticky", all["t.sticky"], StatusOK, "fixed", t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	all, _ = s.LoadAll(ctx)
	if all["t.sticky"].FirstRedAt != nil {
		t.Fatal("recovering must clear first_red_at")
	}
}

func TestUpsert_RejectsDerivedStatuses(t *testing.T) {
	pool := testPool(t)
	truncate(t, pool, "ops_check_results", "ops_check_history")
	s := NewStore(pool)

	err := s.Upsert(context.Background(), "t.derived", Result{}, StatusStale, "", time.Now())
	if err == nil {
		t.Fatal("the DB must refuse to store a derived status: a persisted 'stale' would let a dead reconciler freeze the board at a confident green")
	}
}
