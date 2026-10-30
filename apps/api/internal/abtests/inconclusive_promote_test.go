// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// dbForAB reuses the pool helper the variant-freeze tests already use.
func dbForAB(t *testing.T) *db.Pool { return variantTestPool(t) }

// seedABTest creates a campaign with one variant per (recipients, opens) pair
// and an ab_settings row configured for auto-promotion. Returns the variant ids
// in creation order.
func seedABTest(t *testing.T, pool *db.Pool, ctx context.Context, arms [][2]int) (string, string, []string) {
	t.Helper()
	tenantID, campaignID := seedVariantCampaign(t, pool, ctx, "sending", true)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ids := make([]string, 0, len(arms))
	for i, arm := range arms {
		label := string(rune('A' + i))
		var vid string
		if err := tx.QueryRow(ctx, `
INSERT INTO campaign_variants (campaign_id, tenant_id, variant_label, subject, weight)
VALUES ($1::uuid, $2::uuid, $3, $4, 50) RETURNING id::text`,
			campaignID, tenantID, label, "Arm "+label).Scan(&vid); err != nil {
			t.Fatalf("seed variant %s: %v", label, err)
		}
		// Seed the SOURCE data, not campaign_variant_results: ListResults calls
		// refreshResults first, which recomputes that table from
		// campaign_recipients + subscriber_events. Writing the results table
		// directly looks like it works and is silently overwritten — the test
		// would then measure zeros while claiming to measure the arms.
		//
		// Recipients <label>-0 .. <label>-(arm[0]-1)@example.test, each with a
		// delivered event; the first arm[1] of them also opened. One set-based
		// statement per table: the horizon test seeds 45,000 rows, and one round
		// trip per row took minutes on a loaded machine.
		recipients, err := tx.Exec(ctx, `
INSERT INTO campaign_recipients (campaign_id, tenant_id, subscriber_email, variant_id, status)
SELECT $1::uuid, $2::uuid, $3::text || '-' || n || '@example.test', $4::uuid, 'sent'
  FROM generate_series(0, $5::int - 1) AS n`,
			campaignID, tenantID, label, vid, arm[0])
		if err != nil {
			t.Fatalf("seed recipients: %v", err)
		}
		events, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, campaign_id, subscriber_email, event_type, at)
SELECT $1::uuid, $2::uuid, $3::text || '-' || n || '@example.test', e.event_type, now()
  FROM generate_series(0, $4::int - 1) AS n
 CROSS JOIN (VALUES ('delivered'), ('opened')) AS e(event_type)
 WHERE e.event_type = 'delivered' OR n < $5::int`,
			tenantID, campaignID, label, arm[0], arm[1])
		if err != nil {
			t.Fatalf("seed events: %v", err)
		}
		if got := recipients.RowsAffected(); got != int64(arm[0]) {
			t.Fatalf("seeded %d recipients for arm %s, want %d", got, label, arm[0])
		}
		if got, want := events.RowsAffected(), int64(arm[0]+min(arm[1], arm[0])); got != want {
			t.Fatalf("seeded %d events for arm %s, want %d", got, label, want)
		}
		ids = append(ids, vid)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_ab_settings (campaign_id, tenant_id, winner_metric, sample_pct, sample_evaluated_at)
VALUES ($1::uuid, $2::uuid, 'open_rate', 20.00, now())`, campaignID, tenantID); err != nil {
		t.Fatalf("seed ab settings: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return tenantID, campaignID, ids
}

// An A/B test that failed its own statistical bar must not report a winner.
//
// The auto-promote scheduler discarded the verdict entirely:
//
//	winnerID, decided := EvaluateWinnerWithDeps(...)
//	if !decided {
//	    // Tie or no clear signal. Fall back to "first variant" ...
//	    if len(results) > 0 { winnerID = results[0].VariantID; decided = true }
//	}
//
// `ListResults` orders by `variant_label`, so `results[0]` is always variant A.
// Every inconclusive test therefore promoted A, mailed it to the entire
// held-back audience, and wrote `winner_decided_at` — so the report said "A
// won" about a comparison that decided nothing.
//
// Raising the statistical bar (a 500-per-arm floor plus a Šidák correction)
// made this fire MORE often, not less: a 2,000-subscriber list sampled at 20%
// gives 200 per arm and can now never decide legitimately, so every such test
// silently ships variant A under the banner of a win.

func TestAnInconclusiveTestDoesNotPickAlphabetically(t *testing.T) {
	// Two arms, identical performance, sample far below the floor. Nothing
	// here justifies choosing either one.
	results := []VariantResult{
		{VariantID: "v-a", TenantID: "t1", RecipientsCount: 100, Opens: 20},
		{VariantID: "v-b", TenantID: "t1", RecipientsCount: 100, Opens: 20},
	}

	choice := chooseAutoPromotion(results, "", false)
	if choice.VariantID == "" {
		t.Fatal("auto-promote produced no variant at all; the operator asked for " +
			"a send and the held-back audience would never receive one")
	}
	if choice.Conclusive {
		t.Fatal("an undecided evaluation was recorded as a conclusive win")
	}
}

func TestAnInconclusiveChoiceFollowsTheObservedRateNotTheLabel(t *testing.T) {
	// B is observably better; it simply did not clear the significance bar.
	// Choosing A because "A" sorts first is an arbitrary bias with a real
	// cost — it is the worse-performing arm, mailed to everyone remaining.
	results := []VariantResult{
		{VariantID: "v-a", TenantID: "t1", RecipientsCount: 100, Opens: 10},
		{VariantID: "v-b", TenantID: "t1", RecipientsCount: 100, Opens: 30},
	}

	choice := chooseAutoPromotion(results, "", false)
	if choice.VariantID != "v-b" {
		t.Fatalf("chose %q; the best observed arm is v-b. Alphabetical order is "+
			"not a tie-break, it is a bias toward whichever label sorts first",
			choice.VariantID)
	}
	if choice.Conclusive {
		t.Fatal("a better observed rate is not statistical significance")
	}
}

func TestAConclusiveEvaluationIsMarkedConclusive(t *testing.T) {
	results := []VariantResult{
		{VariantID: "v-a", TenantID: "t1", RecipientsCount: 1000, Opens: 100},
		{VariantID: "v-b", TenantID: "t1", RecipientsCount: 1000, Opens: 400},
	}
	choice := chooseAutoPromotion(results, "v-b", true)
	if choice.VariantID != "v-b" || !choice.Conclusive {
		t.Fatalf("choice=%+v, want the evaluator's own winner marked conclusive", choice)
	}
}

func TestNoVariantsMeansNoPromotion(t *testing.T) {
	if choice := chooseAutoPromotion(nil, "", false); choice.VariantID != "" {
		t.Fatalf("choice=%+v, want no promotion from an empty result set", choice)
	}
}

func TestTheReasonIsRecordedForTheOperator(t *testing.T) {
	// The operator has to be able to tell "B won" from "we shipped B because
	// the window closed and it was ahead". Those are different facts and only
	// one of them is evidence.
	results := []VariantResult{
		{VariantID: "v-a", TenantID: "t1", RecipientsCount: 100, Opens: 10},
		{VariantID: "v-b", TenantID: "t1", RecipientsCount: 100, Opens: 30},
	}
	choice := chooseAutoPromotion(results, "", false)
	if !strings.Contains(strings.ToLower(choice.Reason), "inconclusive") {
		t.Fatalf("reason=%q, want it to say the comparison was inconclusive", choice.Reason)
	}
}

// The live path, not just the decision function.
//
// The reviewer's finding was that `Scheduler.promote` had zero test coverage in
// this package — the statistics were well tested and the code that discards
// them was not. This drives the real scheduler against a real database.
func TestSchedulerPromoteRecordsAnInconclusiveResultAsInconclusive(t *testing.T) {
	pool := dbForAB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	tenantID, campaignID, variants := seedABTest(t, pool, ctx, [][2]int{
		// Both arms far below the 500-per-arm floor and near-identical, so the
		// evaluator cannot decide. Before this change the scheduler promoted
		// whichever variant sorted first and stamped it a winner.
		{100, 10},
		{100, 30},
	})

	s := &Scheduler{Repo: repo, Pool: pool}
	if err := s.promote(ctx, tenantID, campaignID); err != nil {
		t.Fatalf("promote: %v", err)
	}

	var winner *string
	var conclusive bool
	var note *string
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT winning_variant_id::text, winner_conclusive, winner_decision_note
  FROM campaign_ab_settings WHERE campaign_id = $1::uuid`, campaignID).
		Scan(&winner, &conclusive, &note); err != nil {
		t.Fatalf("read settings: %v", err)
	}

	if winner == nil {
		t.Fatal("nothing was promoted; the held-back audience receives nothing")
	}
	if conclusive {
		t.Fatal("an inconclusive test was recorded as a statistically decided " +
			"winner — the report would say this variant won")
	}
	if note == nil || *note == "" {
		t.Fatal("no reason recorded, so an operator cannot tell why this shipped")
	}
	// And it shipped the better-performing arm, not the alphabetically first.
	if *winner != variants[1] {
		t.Fatalf("promoted %q, want the best observed arm %q", *winner, variants[1])
	}
}
