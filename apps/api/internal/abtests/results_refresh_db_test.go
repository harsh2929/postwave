// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ListResults recomputes every arm from campaign_recipients and
// subscriber_events before it reads. These tests pin what that recomputation
// counts, for both ways an A/B test comes into being:
//
//   - POST /api/v1/campaigns/{id}/variants puts the arms on the campaign
//     itself, and the queue path assigns that campaign's recipients to them.
//   - POST /api/v1/campaigns/ab-test puts the arms on a parent and queues the
//     audience on one child campaign per arm. Each child recipient carries the
//     PARENT's variant id, and its engagement is recorded against the CHILD.
//
// A rewrite of the refresh that selected recipients by campaign instead of by
// variant passed every other test in this package and reported zeros for
// every test created the second way.
//
// Every expected number below is counted by hand from the fixture next to it.

// armCounts is the part of a VariantResult the refresh computes.
type armCounts struct {
	Recipients, Delivered, Opens, Clicks, Unsubscribes, Complaints int
}

func countsOf(r VariantResult) armCounts {
	return armCounts{
		Recipients:   r.RecipientsCount,
		Delivered:    r.Delivered,
		Opens:        r.Opens,
		Clicks:       r.Clicks,
		Unsubscribes: r.Unsubscribes,
		Complaints:   r.Complaints,
	}
}

// createArms creates the arms through the same repository call both creation
// paths use, and returns their ids by label.
func createArms(t *testing.T, ctx context.Context, repo *Repo, tenantID, campaignID string, labels ...string) map[string]string {
	t.Helper()
	variants := make([]Variant, 0, len(labels))
	for _, label := range labels {
		variants = append(variants, Variant{VariantLabel: label, Subject: "Arm " + label, Weight: 50})
	}
	created, err := repo.CreateVariants(ctx, tenantID, campaignID, variants)
	if err != nil {
		t.Fatalf("CreateVariants: %v", err)
	}
	ids := make(map[string]string, len(created))
	for _, v := range created {
		ids[v.VariantLabel] = v.ID
	}
	if len(ids) != len(labels) {
		t.Fatalf("created %d arms, want %d", len(ids), len(labels))
	}
	return ids
}

// fixtureTx is one tenant-scoped transaction that seeds source rows.
type fixtureTx struct {
	t        *testing.T
	ctx      context.Context
	tx       pgx.Tx
	tenantID string
}

func beginFixture(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) *fixtureTx {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return &fixtureTx{t: t, ctx: ctx, tx: tx, tenantID: tenantID}
}

func (f *fixtureTx) commit() {
	f.t.Helper()
	if err := f.tx.Commit(f.ctx); err != nil {
		f.t.Fatalf("commit fixture: %v", err)
	}
}

// campaign inserts a plain campaign of the fixture's tenant.
func (f *fixtureTx) campaign(name string) string {
	f.t.Helper()
	var id string
	if err := f.tx.QueryRow(f.ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html)
VALUES ($1::uuid, $2, 's', 'sent', '<p>x</p>') RETURNING id::text`, f.tenantID, name).Scan(&id); err != nil {
		f.t.Fatalf("seed campaign %s: %v", name, err)
	}
	return id
}

// childCampaign inserts a child the way campaigns.createABTest does: its
// delivery_settings.ab_test names the parent and the parent's canonical arm.
func (f *fixtureTx) childCampaign(parentID, label, canonicalVariantID string, index, total int) string {
	f.t.Helper()
	var id string
	if err := f.tx.QueryRow(f.ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, delivery_settings)
VALUES ($1::uuid, 'ab — variant ' || $3, 's', 'sent', '<p>x</p>',
        jsonb_build_object('ab_test', jsonb_build_object(
            'parent_id', $2::text, 'variant_id', $3::text,
            'canonical_variant_id', $4::text,
            'variant_index', $5::int, 'total_variants', $6::int)))
RETURNING id::text`, f.tenantID, parentID, label, canonicalVariantID, index, total).Scan(&id); err != nil {
		f.t.Fatalf("seed child campaign %s: %v", label, err)
	}
	return id
}

// recipient queues one address on a campaign; an empty variantID leaves the
// row unassigned.
func (f *fixtureTx) recipient(campaignID, email, variantID string) {
	f.t.Helper()
	if _, err := f.tx.Exec(f.ctx, `
INSERT INTO campaign_recipients (campaign_id, tenant_id, subscriber_email, variant_id, status)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, '')::uuid, 'sent')`,
		campaignID, f.tenantID, email, variantID); err != nil {
		f.t.Fatalf("seed recipient %s: %v", email, err)
	}
}

// event records one engagement event; an empty campaignID stores NULL, and
// age is subtracted from now().
func (f *fixtureTx) event(campaignID, email, eventType, age string) {
	f.t.Helper()
	if _, err := f.tx.Exec(f.ctx, `
INSERT INTO subscriber_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4, now() - $5::interval)`,
		f.tenantID, campaignID, email, eventType, age); err != nil {
		f.t.Fatalf("seed %s event for %s: %v", eventType, email, err)
	}
}

// assertArms compares ListResults for campaignID with the expected counts per
// arm label, reporting every arm that differs.
func assertArms(t *testing.T, ctx context.Context, repo *Repo, tenantID, campaignID string, ids map[string]string, want map[string]armCounts) []VariantResult {
	t.Helper()
	results, err := repo.ListResults(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("ListResults: %v", err)
	}
	labelOf := make(map[string]string, len(ids))
	for label, id := range ids {
		labelOf[id] = label
	}
	if len(results) != len(want) {
		t.Fatalf("ListResults returned %d arms, want %d", len(results), len(want))
	}
	for _, r := range results {
		label, ok := labelOf[r.VariantID]
		if !ok {
			t.Fatalf("ListResults returned variant %s, which is not an arm of this campaign", r.VariantID)
		}
		if got := countsOf(r); got != want[label] {
			t.Errorf("arm %s: got %+v, want %+v", label, got, want[label])
		}
	}
	return results
}

func TestResultsFollowAnABTestParentIntoItsChildCampaigns(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}

	tenantID, parentID := seedVariantCampaign(t, pool, ctx, "draft", false)
	arms := createArms(t, ctx, repo, tenantID, parentID, "A", "B", "C")

	f := beginFixture(t, ctx, pool, tenantID)
	childA := f.childCampaign(parentID, "A", arms["A"], 0, 3)
	childB := f.childCampaign(parentID, "B", arms["B"], 1, 3)
	// Arm C's child has not been queued: C has no recipients anywhere.

	// Arm A: six addresses, queued on child A and stamped with the parent's arm.
	for n := 0; n < 6; n++ {
		f.recipient(childA, fmt.Sprintf("a%d@example.test", n), arms["A"])
	}
	for n := 0; n < 6; n++ {
		f.event(childA, fmt.Sprintf("a%d@example.test", n), "delivered", "0")
	}
	f.event(childA, "a0@example.test", "opened", "0")
	f.event(childA, "A0@EXAMPLE.TEST", "opened", "0") // a repeat open, other case: still one address
	f.event(childA, "a1@example.test", "opened", "0")
	f.event(childA, "a2@example.test", "opened", "0")
	f.event(childA, "a1@example.test", "clicked", "0")
	f.event(childA, "a5@example.test", "unsubscribed", "0")
	f.event(childA, "A4@EXAMPLE.TEST", "complained", "0") // matched case-insensitively
	f.event(childA, "a3@example.test", "bounced", "0")    // not one of the counted types
	// Arm B: four addresses on child B.
	for n := 0; n < 4; n++ {
		f.recipient(childB, fmt.Sprintf("b%d@example.test", n), arms["B"])
		f.event(childB, fmt.Sprintf("b%d@example.test", n), "delivered", "0")
	}
	f.event(childB, "b0@example.test", "opened", "0")

	// None of these may count for any arm:
	f.event(childB, "a3@example.test", "clicked", "0")   // a3 was queued on child A, not child B
	f.event(parentID, "a2@example.test", "clicked", "0") // nobody was queued on the parent
	f.event("", "a4@example.test", "clicked", "0")       // no campaign at all
	f.recipient(childA, "held@example.test", "")         // an unassigned row on a child
	f.event(childA, "held@example.test", "delivered", "0")
	f.event(childA, "held@example.test", "opened", "0")
	f.commit()

	assertArms(t, ctx, repo, tenantID, parentID, arms, map[string]armCounts{
		"A": {Recipients: 6, Delivered: 6, Opens: 3, Clicks: 1, Unsubscribes: 1, Complaints: 1},
		"B": {Recipients: 4, Delivered: 4, Opens: 1},
		"C": {},
	})
}

func TestResultsCountAddressesNotEventsLetterCaseOrOtherTenants(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}

	tenantID, campaignID := seedVariantCampaign(t, pool, ctx, "draft", false)
	arms := createArms(t, ctx, repo, tenantID, campaignID, "A", "B", "C")
	otherTenantID, _ := seedVariantCampaign(t, pool, ctx, "draft", false)

	f := beginFixture(t, ctx, pool, tenantID)
	other := f.campaign("other campaign, same tenant")
	for _, r := range []struct{ email, arm string }{
		{"Alice@Example.TEST", "A"},
		{"bob@example.test", "A"},
		{"Erin@Example.test", "A"},
		{"quiet@example.test", "A"},
		{"carol@example.test", "B"},
		{"dave@example.test", "B"},
	} {
		f.recipient(campaignID, r.email, arms[r.arm])
	}
	f.recipient(campaignID, "held@example.test", "") // queued, but in no arm

	f.event(campaignID, "alice@example.test", "delivered", "0")
	f.event(campaignID, "ALICE@EXAMPLE.TEST", "delivered", "0") // provider retry, other case
	f.event(campaignID, "Alice@Example.TEST", "opened", "0")
	f.event(campaignID, "alice@example.test", "opened", "0")
	f.event(campaignID, "alice@example.test", "clicked", "0")
	f.event(campaignID, "alice@example.test", "bounced", "0")
	f.event(campaignID, "alice@example.test", "replied", "0")
	f.event(campaignID, "BOB@example.test", "delivered", "0")
	f.event(campaignID, "bob@example.test", "unsubscribed", "0")
	f.event(campaignID, "Bob@Example.Test", "complained", "0")
	f.event(campaignID, "erin@example.test", "delivered", "0")
	f.event(campaignID, "ERIN@example.TEST", "opened", "0")
	f.event(campaignID, "carol@example.test", "delivered", "0")
	f.event(campaignID, "carol@example.test", "delivered", "0")
	f.event(campaignID, "dave@example.test", "custom", "0")
	f.event(campaignID, "dave@example.test", "delivered", "400 days") // the refresh has no time window
	f.event(campaignID, "held@example.test", "delivered", "0")
	f.event(campaignID, "stranger@example.test", "delivered", "0") // never queued
	f.event("", "carol@example.test", "opened", "0")
	f.event(other, "carol@example.test", "opened", "0")
	f.event(other, "dave@example.test", "clicked", "0")
	f.commit()

	// Another tenant's rows claiming this campaign and this arm. The foreign
	// keys are single-column, so nothing stops them being written; tenant
	// isolation has to keep them out of the counts.
	o := beginFixture(t, ctx, pool, otherTenantID)
	o.recipient(campaignID, "intruder@example.test", arms["A"])
	o.event(campaignID, "intruder@example.test", "delivered", "0")
	o.event(campaignID, "quiet@example.test", "delivered", "0")
	o.event(campaignID, "carol@example.test", "opened", "0")
	o.event(campaignID, "dave@example.test", "clicked", "0")
	o.commit()

	// A results row left over from an earlier refresh, on an arm that has since
	// lost every recipient. It must be recomputed to zero, and the refresh must
	// leave the winner flag (MarkWinner's) alone.
	s := beginFixture(t, ctx, pool, tenantID)
	if _, err := s.tx.Exec(ctx, `
INSERT INTO campaign_variant_results
    (variant_id, tenant_id, recipients_count, delivered, opens, clicks, unsubscribes, complaints, winner)
VALUES ($1::uuid, $2::uuid, 99, 98, 97, 96, 95, 94, true)`, arms["C"], tenantID); err != nil {
		t.Fatalf("seed stale results row: %v", err)
	}
	s.commit()

	results := assertArms(t, ctx, repo, tenantID, campaignID, arms, map[string]armCounts{
		"A": {Recipients: 4, Delivered: 3, Opens: 2, Clicks: 1, Unsubscribes: 1, Complaints: 1},
		"B": {Recipients: 2, Delivered: 2},
		"C": {},
	})
	for _, r := range results {
		if r.VariantID == arms["C"] && !r.Winner {
			t.Errorf("the refresh cleared arm C's winner flag; only MarkWinner may write it")
		}
	}
}

// When the parent of an ab-test is queued as well as its children, one arm has
// rows on several campaigns, and the same person can be one of them twice.
// recipients_count counts queued rows; the engagement counts count people.
//
// An event counts for a queued row only when it was recorded on that row's
// campaign, in both directions: an event on a child does not count for someone
// queued only on the parent, and an event on the parent does not count for
// someone queued only on a child, even though the parent has rows of the same
// arm.
//
// Counted by hand, recipient row by recipient row:
//
//	arm A  parent h1   delivered (parent)                  -> delivered
//	       parent h2   delivered (parent)                  -> delivered
//	       child A h1  delivered, opened (child A)         -> delivered, opened
//	       child A h4  delivered (child A)                 -> delivered
//	       4 rows; delivered {h1, h2, h4} = 3; opened {h1} = 1.
//	       Not counted: h2 opened on child A (h2 is queued on the parent only),
//	       h4 opened on the parent (h4 is queued on child A only).
//	arm B  parent h3   delivered (parent)                  -> delivered
//	       child B h5  nothing on child B
//	       2 rows; delivered {h3} = 1.
//	       Not counted: h5 delivered on the parent (h5 is queued on child B only).
func TestResultsCountRowsAndPeopleOfAnArmQueuedOnSeveralCampaigns(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}

	tenantID, parentID := seedVariantCampaign(t, pool, ctx, "draft", false)
	arms := createArms(t, ctx, repo, tenantID, parentID, "A", "B")

	f := beginFixture(t, ctx, pool, tenantID)
	childA := f.childCampaign(parentID, "A", arms["A"], 0, 2)
	childB := f.childCampaign(parentID, "B", arms["B"], 1, 2)
	f.recipient(parentID, "h1@example.test", arms["A"])
	f.recipient(parentID, "h2@example.test", arms["A"])
	f.recipient(parentID, "h3@example.test", arms["B"])
	f.recipient(childA, "H1@Example.TEST", arms["A"]) // h1 again, on the child
	f.recipient(childA, "h4@example.test", arms["A"])
	f.recipient(childB, "h5@example.test", arms["B"])

	f.event(parentID, "h1@example.test", "delivered", "0")
	f.event(parentID, "h2@example.test", "delivered", "0")
	f.event(parentID, "h3@example.test", "delivered", "0")
	f.event(childA, "h1@example.test", "delivered", "0") // h1 delivered twice, once per campaign
	f.event(childA, "h1@example.test", "opened", "0")
	f.event(childA, "h4@example.test", "delivered", "0")
	f.event(childA, "h2@example.test", "opened", "0")      // h2 was not queued on child A
	f.event(parentID, "h4@example.test", "opened", "0")    // h4 was queued on child A only
	f.event(parentID, "h5@example.test", "delivered", "0") // h5 was queued on child B only
	f.commit()

	assertArms(t, ctx, repo, tenantID, parentID, arms, map[string]armCounts{
		"A": {Recipients: 4, Delivered: 3, Opens: 1},
		"B": {Recipients: 2, Delivered: 1},
	})
}

// The refresh must not be able to degrade into a loop over recipients that
// re-reads the campaign's events for each one.
//
// The email match cannot be an index condition (RLS, and neither lower() nor
// citext equality is LEAKPROOF), so such a nested loop is O(recipients x
// events). On the never-analysed CI database the planner chose it: minutes per
// refresh, and the package hit the 10-minute test timeout. Result tests cannot
// see this: a nested loop returns the same numbers, slowly.
//
// So look at the plan, with hash and merge joins switched off to make a loop
// as attractive as it can be. If the planner still joins events to recipients
// with a hash or merge join, it had no other way to run the statement.
func TestTheRefreshCannotJoinEventsToRecipientsInALoop(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	tenantID, campaignID := seedPlanFixture(t, ctx, pool)

	root, raw := explainRefresh(t, ctx, pool, tenantID, campaignID, "enable_hashjoin", "enable_mergejoin")
	fullJoins := 0
	ctes := indexCTEs(root)
	root.walk(func(n planNode) {
		if !ctes.joins(n, "campaign_recipients", "subscriber_events") {
			return
		}
		switch {
		case n.NodeType == "Nested Loop":
			t.Errorf("a %s nested loop joins recipient rows to event rows: every row "+
				"of one side re-reads the other:\n%s", n.JoinType, raw)
		case (n.NodeType == "Hash Join" || n.NodeType == "Merge Join") && n.JoinType == "Full":
			fullJoins++
		}
	})
	// Also guards this test: if the plan stopped naming either table, the loop
	// check above would pass vacuously.
	if fullJoins == 0 {
		t.Errorf("no hash or merge FULL join of recipient rows to event rows in the "+
			"plan; the join that makes a nested loop impossible is gone:\n%s", raw)
	}
}

// Only the events of the campaigns the arms' recipients were queued on may
// enter the join, not every event the tenant has ever recorded.
//
// No result can show this. An event on any other campaign matches no
// recipient, so it lands in the FULL JOIN's unassigned group and changes no
// arm. It shows only in the cost: without the pre-filter
// `se.campaign_id = ANY (ARRAY(SELECT DISTINCT campaign_id FROM assigned))`
// every counted event of the tenant goes through the join and its sort. On a
// tenant with 600,000 events on an unrelated campaign that took a refresh from
// 77 ms to 4.2 s on PostgreSQL 16, and it grows with the tenant's whole
// history. Every result test in this package passes without it.
//
// So look at how each partition of subscriber_events is read: the campaigns
// must be applied right there, so that another campaign's event is dropped by
// the scan that finds it. Where the planner applies them depends on the server
// version and the statistics. On this fixture PostgreSQL 17 makes them an index
// condition on the (tenant_id, campaign_id) index, while PostgreSQL 16, which CI
// runs, fetches by tenant and filters by campaign. Either way the scan names
// the campaigns. Without the pre-filter it names only the tenant.
func TestTheRefreshJoinsOnlyTheEventsOfTheArmsCampaigns(t *testing.T) {
	pool := dbForAB(t)
	ctx := context.Background()
	tenantID, campaignID := seedPlanFixture(t, ctx, pool)

	root, raw := explainRefresh(t, ctx, pool, tenantID, campaignID)
	const campaigns = "campaign_id = ANY"
	eventScans := 0
	root.walk(func(n planNode) {
		if !n.reads("subscriber_events") {
			return
		}
		eventScans++
		if !strings.Contains(n.IndexCond, campaigns) && !strings.Contains(n.RecheckCond, campaigns) &&
			!strings.Contains(n.Filter, campaigns) {
			t.Errorf("%s on %s does not restrict the events it reads to the arms' campaigns, "+
				"so every event of the tenant enters the join (Index Cond %q, Recheck Cond %q, "+
				"Filter %q):\n%s", n.NodeType, n.RelationName, n.IndexCond, n.RecheckCond, n.Filter, raw)
		}
	})
	// Guards the check above, which passes vacuously on a plan that no longer
	// names the table.
	if eventScans == 0 {
		t.Errorf("the plan reads no subscriber_events relation:\n%s", raw)
	}
}

// seedPlanFixture creates a campaign with two arms of ten recipients each, and
// one delivered event per recipient. The plan tests need rows, not particular
// counts.
func seedPlanFixture(t *testing.T, ctx context.Context, pool *db.Pool) (tenantID, campaignID string) {
	t.Helper()
	repo := &Repo{Pool: pool}
	tenantID, campaignID = seedVariantCampaign(t, pool, ctx, "draft", false)
	arms := createArms(t, ctx, repo, tenantID, campaignID, "A", "B")
	f := beginFixture(t, ctx, pool, tenantID)
	for n := 0; n < 20; n++ {
		email := fmt.Sprintf("p%d@example.test", n)
		f.recipient(campaignID, email, arms[[]string{"A", "B"}[n%2]])
		f.event(campaignID, email, "delivered", "0")
	}
	f.commit()
	return tenantID, campaignID
}

// explainRefresh plans refreshResultsSQL for campaignID in a transaction of the
// campaign's tenant, with each named planner setting switched off, and returns
// the plan and its JSON text.
func explainRefresh(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, campaignID string, off ...string) (planNode, string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, setting := range off {
		if _, err := tx.Exec(ctx, "SET LOCAL "+setting+" = off"); err != nil {
			t.Fatalf("SET LOCAL %s: %v", setting, err)
		}
	}
	var raw string
	if err := tx.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+refreshResultsSQL, tenantID, campaignID).Scan(&raw); err != nil {
		t.Fatalf("EXPLAIN refreshResultsSQL: %v", err)
	}
	var plans []struct {
		Plan planNode `json:"Plan"`
	}
	if err := json.Unmarshal([]byte(raw), &plans); err != nil || len(plans) != 1 {
		t.Fatalf("decode plan (%v): %s", err, raw)
	}
	return plans[0].Plan, raw
}

// planNode is the part of EXPLAIN (FORMAT JSON) output the plan tests read.
type planNode struct {
	NodeType           string     `json:"Node Type"`
	JoinType           string     `json:"Join Type"`
	ParentRelationship string     `json:"Parent Relationship"`
	SubplanName        string     `json:"Subplan Name"`
	RelationName       string     `json:"Relation Name"`
	CTEName            string     `json:"CTE Name"`
	IndexCond          string     `json:"Index Cond"`
	RecheckCond        string     `json:"Recheck Cond"`
	Filter             string     `json:"Filter"`
	Plans              []planNode `json:"Plans"`
}

// walk visits n and every node below it.
func (n planNode) walk(visit func(planNode)) {
	visit(n)
	for _, child := range n.Plans {
		child.walk(visit)
	}
}

// reads reports whether n scans relation itself or one of its partitions,
// which EXPLAIN names relation_<suffix>.
func (n planNode) reads(relation string) bool {
	return n.RelationName == relation || strings.HasPrefix(n.RelationName, relation+"_")
}

// planCTEs maps each CTE name in a plan to the plan that computes it.
type planCTEs map[string]planNode

func indexCTEs(root planNode) planCTEs {
	ctes := planCTEs{}
	root.walk(func(n planNode) {
		if name, ok := strings.CutPrefix(n.SubplanName, "CTE "); ok {
			ctes[name] = n
		}
	})
	return ctes
}

// carries reports whether n emits rows of relation (or of one of its
// partitions, which EXPLAIN names relation_<suffix>) one for one. A CTE Scan
// carries what its CTE carries. An Aggregate carries nothing: it emits one row
// per group, so a loop over its output is not a loop over the table. InitPlans
// and SubPlans feed parameters, not rows.
func (ctes planCTEs) carries(n planNode, relation string) bool {
	if n.reads(relation) {
		return true
	}
	switch n.NodeType {
	case "Aggregate":
		return false
	case "CTE Scan":
		cte, ok := ctes[n.CTEName]
		return ok && ctes.carries(cte, relation)
	}
	for _, child := range n.Plans {
		if child.ParentRelationship == "InitPlan" || child.ParentRelationship == "SubPlan" {
			continue
		}
		if ctes.carries(child, relation) {
			return true
		}
	}
	return false
}

// joins reports whether join node n has rows of a on one side and rows of b
// on the other.
func (ctes planCTEs) joins(n planNode, a, b string) bool {
	var outer, inner *planNode
	for i := range n.Plans {
		switch n.Plans[i].ParentRelationship {
		case "Outer":
			outer = &n.Plans[i]
		case "Inner":
			inner = &n.Plans[i]
		}
	}
	if outer == nil || inner == nil {
		return false
	}
	return (ctes.carries(*outer, a) && ctes.carries(*inner, b)) ||
		(ctes.carries(*outer, b) && ctes.carries(*inner, a))
}
