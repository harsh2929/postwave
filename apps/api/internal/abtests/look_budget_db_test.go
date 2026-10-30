// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The alpha budget is only a budget if it is spent atomically.
//
// The correction raises the cutoff for a FIXED number of looks. If the counter
// can be lost — two schedulers reading 6, both writing 7 — the campaign takes
// more looks than the cutoff was computed for, and the cutoff quietly stops
// covering the peeking it was raised to cover. Nothing surfaces: the counter
// looks plausible, the test still concludes, and the false-winner rate drifts
// back toward the 37.8% this whole change exists to remove.
//
// The same lost-update shape, one level down from the statistics.

func seedABSettings(t *testing.T, pool *db.Pool, ctx context.Context) (tenantID, campaignID string) {
	t.Helper()
	tenantID, campaignID = seedVariantCampaign(t, pool, ctx, "draft", false)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_ab_settings (tenant_id, campaign_id, winner_metric)
VALUES ($1::uuid, $2::uuid, 'open_rate')`, tenantID, campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed ab settings: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit ab settings: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM campaign_ab_settings WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, campaignID
}

func TestEveryLookIsCountedEvenWhenTheyRaceEachOther(t *testing.T) {
	pool := variantTestPool(t)
	ctx := context.Background()
	tenantID, campaignID := seedABSettings(t, pool, ctx)
	repo := &Repo{Pool: pool}

	// The real race: the 30-minute recompute worker firing while an operator
	// POSTs /ab/evaluate, plus any second API process.
	const concurrent = 12
	var wg sync.WaitGroup
	seen := make([]int, concurrent)
	errs := make([]error, concurrent)
	wg.Add(concurrent)
	for i := 0; i < concurrent; i++ {
		go func(i int) {
			defer wg.Done()
			seen[i], errs[i] = repo.RecordWinnerLook(ctx, tenantID, campaignID)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("look %d: %v", i, err)
		}
	}

	// Every caller must have been handed a DIFFERENT ordinal. A duplicate means
	// two callers both believed they were the same look, so one look went
	// unpaid for.
	distinct := map[int]bool{}
	for _, v := range seen {
		if distinct[v] {
			t.Fatalf("two concurrent looks were both told they were look %d; the "+
				"counter is a read-modify-write and the budget can be overspent "+
				"without anything noticing (got %v)", v, seen)
		}
		distinct[v] = true
	}

	settings, err := repo.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if settings.WinnerLooksTaken != concurrent {
		t.Fatalf("winner_looks_taken = %d after %d concurrent looks; %d were lost",
			settings.WinnerLooksTaken, concurrent, concurrent-settings.WinnerLooksTaken)
	}
}

func TestTheBudgetSurvivesAReadBack(t *testing.T) {
	pool := variantTestPool(t)
	ctx := context.Background()
	tenantID, campaignID := seedABSettings(t, pool, ctx)
	repo := &Repo{Pool: pool}

	settings, err := repo.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	// A fresh campaign has spent nothing and asks for the default horizon. If
	// GetSettings stopped selecting the column this would silently read 0
	// forever and the budget would never be spendable — the guard would be
	// present, permanent, and inert.
	if got := settings.LookBudget(); got.Taken != 0 || got.Planned != 48 {
		t.Fatalf("fresh budget = %+v, want {Planned:48 Taken:0}", got)
	}

	for want := 1; want <= 3; want++ {
		got, err := repo.RecordWinnerLook(ctx, tenantID, campaignID)
		if err != nil {
			t.Fatalf("RecordWinnerLook: %v", err)
		}
		if got != want {
			t.Fatalf("RecordWinnerLook returned %d, want %d", got, want)
		}
	}

	settings, err = repo.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if settings.LookBudget().Taken != 3 {
		t.Fatalf("budget read back as %+v after 3 looks", settings.LookBudget())
	}
}

// Does the SCHEDULER actually spend the budget, or does it merely compute one?
//
// This exists because a mutation proved it did not need to. Replacing the
// scheduler's `budget.Taken = taken` with a hard-coded 1 — so the horizon is
// calculated, the counter still increments, and the number is thrown away
// before it reaches the decision — left the entire package green. Every
// assertion about the budget was on the helper; nothing drove the caller.
//
// That is the same shape as the bug being fixed: a correction that exists and
// is not applied. So the assertion here is deliberately end-to-end — seed a
// campaign whose budget is already exhausted, run the real promote path, and
// require that no CONCLUSIVE winner comes out of it.
func TestTheSchedulerRefusesToDecideOnceTheHorizonIsSpent(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}

	// An unambiguous winner: 30% vs 20% over 5000 recipients each clears every
	// cutoff in this package with room to spare. If the horizon is enforced,
	// even this cannot be called conclusive.
	tenantID, campaignID, _ := seedABTest(t, pool, ctx, [][2]int{
		{5000, 1500},
		{5000, 1000},
	})

	readConclusive := func() bool {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var conclusive bool
		if err := tx.QueryRow(ctx, `
SELECT winner_conclusive FROM campaign_ab_settings WHERE campaign_id = $1::uuid`,
			campaignID).Scan(&conclusive); err != nil {
			t.Fatalf("read settings: %v", err)
		}
		return conclusive
	}

	// Control first. Without it, a scheduler that never decides anything would
	// pass the real assertion below and prove nothing.
	s := &Scheduler{Repo: repo, Pool: pool}
	if err := s.promote(ctx, tenantID, campaignID); err != nil {
		t.Fatalf("promote within the horizon: %v", err)
	}
	if !readConclusive() {
		t.Fatal("a 30 vs 20 percent split over 5000 recipients per arm was not called " +
			"conclusive on the first look; the rule can no longer detect a real effect")
	}

	// Now exhaust the budget and re-run against a fresh, identical campaign.
	tenantID, campaignID, _ = seedABTest(t, pool, ctx, [][2]int{
		{5000, 1500},
		{5000, 1000},
	})
	settings, err := repo.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	planned := settings.LookBudget().Planned
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_ab_settings SET winner_looks_taken = $2 WHERE campaign_id = $1::uuid`,
		campaignID, planned); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("exhaust budget: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// promote() spends one more look, taking it to planned+1 — past the horizon.
	s2 := &Scheduler{Repo: repo, Pool: pool}
	if err := s2.promote(ctx, tenantID, campaignID); err != nil {
		t.Fatalf("promote past the horizon: %v", err)
	}
	if readConclusive() {
		t.Fatalf("the scheduler declared a CONCLUSIVE winner on look %d of a "+
			"%d-look budget. The cutoff was raised for a fixed number of looks; "+
			"taking more of them than were paid for puts the false-winner rate "+
			"back where it started.", planned+1, planned)
	}
}
