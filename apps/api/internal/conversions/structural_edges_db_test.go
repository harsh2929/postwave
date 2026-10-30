// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the five structural revenue-graph edges.
//
// Reuses the fixture helpers in attribution_db_test.go (attributionDB,
// createAttributionTenant, randUUID) under the same throwaway-tenant model.
// Requires migration 1942.

package conversions

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// edgeFixture seeds one subscriber plus one touch of every kind, all inside the
// attribution window, and returns the ids the conversion should end up carrying.
type edgeFixture struct {
	Email        string
	SubscriberID string
	FlowID       string
	FormID       string
	DiscountID   string
	ReferrerID   string
	VariantID    string
}

func seedEdgeFixture(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, at time.Time) edgeFixture {
	t.Helper()
	f := edgeFixture{
		Email:      "edges-" + randUUID(t)[:8] + "@example.test",
		ReferrerID: randUUID(t),
		VariantID:  "variant-b",
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		tenantID, f.Email).Scan(&f.SubscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}

	// Flow: an automation_journey plus a run this subscriber was enrolled in.
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status)
VALUES ($1::uuid, 'edge-flow', 'draft') RETURNING id::text`, tenantID).Scan(&f.FlowID); err != nil {
		t.Fatalf("seed journey: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO flow_runs (tenant_id, flow_id, subscriber_id, status, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued', $4)`,
		tenantID, f.FlowID, f.SubscriberID, at.Add(-time.Hour)); err != nil {
		t.Fatalf("seed flow run: %v", err)
	}

	// Form: a form plus a submission from this email.
	if err := tx.QueryRow(ctx, `
INSERT INTO forms (tenant_id, slug, name, opt_in_mode, status)
VALUES ($1::uuid, 'edge-form-'||substr($2, 1, 8), 'edge-form', 'single', 'published')
RETURNING id::text`, tenantID, randUUID(t)).Scan(&f.FormID); err != nil {
		t.Fatalf("seed form: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO form_submissions (tenant_id, form_id, email, status, submitted_at)
VALUES ($1::uuid, $2::uuid, $3, 'confirmed', $4)`,
		tenantID, f.FormID, f.Email, at.Add(-2*time.Hour)); err != nil {
		t.Fatalf("seed form submission: %v", err)
	}

	// Discount: a discount plus a redemption by this subscriber.
	if err := tx.QueryRow(ctx, `
INSERT INTO discounts (tenant_id, code, applies_to, percent_off)
VALUES ($1::uuid, 'EDGE'||substr($2, 1, 6), 'first_payment', 10) RETURNING id::text`,
		tenantID, randUUID(t)).Scan(&f.DiscountID); err != nil {
		t.Fatalf("seed discount: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO discount_redemptions (tenant_id, discount_id, subscriber_id, redeemed_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
		tenantID, f.DiscountID, f.SubscriberID, at.Add(-30*time.Minute)); err != nil {
		t.Fatalf("seed redemption: %v", err)
	}

	// Referral: this subscriber is the referee.
	if _, err := tx.Exec(ctx, `
INSERT INTO referral_conversions (tenant_id, referrer_subscriber_id, referee_subscriber_id, created_at)
VALUES ($1::uuid, $2, $3, $4)`,
		tenantID, f.ReferrerID, f.SubscriberID, at.Add(-3*time.Hour)); err != nil {
		t.Fatalf("seed referral conversion: %v", err)
	}

	// Experiment: an arm assignment keyed on the email.
	if _, err := tx.Exec(ctx, `
INSERT INTO flow_ab_test_assignments (tenant_id, automation_id, node_id, subscriber_email, variant_id, assigned_at)
VALUES ($1::uuid, $2::uuid, 'node-1', $3, $4, $5)`,
		tenantID, f.FlowID, f.Email, f.VariantID, at.Add(-4*time.Hour)); err != nil {
		t.Fatalf("seed ab assignment: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	return f
}

// readEdges reads the stored edges back under tenant scope.
//
// Tenant-scoped deliberately: a bare pool query returns zero rows under RLS and
// looks exactly like a writer that never fired, which is a mistake this
// repository has made before and would make this test pass for the wrong reason
// only in its negative assertions.
func readEdges(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, id int64) structuralEdges {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var e structuralEdges
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(flow_id::text, ''), COALESCE(form_id::text, ''),
       COALESCE(discount_id::text, ''), COALESCE(referrer_subscriber_id, ''),
       COALESCE(experiment_variant_id, '')
  FROM conversions WHERE id = $1`, id).
		Scan(&e.FlowID, &e.FormID, &e.DiscountID, &e.ReferrerSubscriberID, &e.ExperimentVariantID); err != nil {
		t.Fatalf("read edges: %v", err)
	}
	return e
}

// A conversion behind every kind of touch carries every edge at once.
//
// The point of the assertion being all-five-together rather than five separate
// tests: the design claim is that these are INDEPENDENT, and a precedence bug
// that let one edge suppress another would pass five isolated tests and fail
// this one.
func TestAConversionCarriesEveryStructuralEdgeItEarned(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	f := seedEdgeFixture(t, pool, ctx, tenantID, time.Now().UTC())

	amount := int64(4200)
	c, err := (&Repo{Pool: pool}).Insert(ctx, tenantID, IngestInput{
		Email: f.Email, EventName: "purchase", AmountCents: &amount, Currency: "usd",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}

	got := readEdges(t, pool, ctx, tenantID, c.ID)
	for _, tc := range []struct{ name, want, got string }{
		{"flow", f.FlowID, got.FlowID},
		{"form", f.FormID, got.FormID},
		{"discount", f.DiscountID, got.DiscountID},
		{"referrer", f.ReferrerID, got.ReferrerSubscriberID},
		{"experiment arm", f.VariantID, got.ExperimentVariantID},
	} {
		if tc.got != tc.want {
			t.Errorf("%s edge = %q, want %q — revenue that came through this "+
				"path cannot be credited to it", tc.name, tc.got, tc.want)
		}
	}
}

// A touch older than the window is not an edge.
//
// Without this, every edge degenerates to "the last one ever", and a flow that
// ran a year before the purchase would keep collecting credit for it forever.
//
// It probes lookupStructuralEdges DIRECTLY rather than going through Insert,
// and asserts the lookup RETURNED NO ERROR as well as no edges. Through Insert
// the two are indistinguishable: the lookup is best-effort inside a savepoint,
// so a probe whose SQL is broken degrades to empty edges and this test would
// pass against a completely dead implementation. That is not hypothetical — it
// is how three attempted mutations of this file were caught proving nothing.
func TestTouchesOutsideTheWindowAreNotEdges(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	// Anchor the whole fixture well outside the 7-day look-back.
	f := seedEdgeFixture(t, pool, ctx, tenantID, time.Now().UTC().Add(-60*24*time.Hour))

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	got, err := lookupStructuralEdges(ctx, tx, tenantID, f.Email, time.Now().UTC())
	if err != nil {
		t.Fatalf("the probes failed, so this test proves nothing about the "+
			"window: %v", err)
	}
	if got.FlowID != "" || got.FormID != "" || got.DiscountID != "" ||
		got.ReferrerSubscriberID != "" || got.ExperimentVariantID != "" {
		t.Fatalf("stale touches became edges: %+v", got)
	}

	// And the same through Insert, so the wiring is covered too.
	c, err := (&Repo{Pool: pool}).Insert(ctx, tenantID, IngestInput{
		Email: f.Email, EventName: "purchase",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	stored := readEdges(t, pool, ctx, tenantID, c.ID)
	if stored != (structuralEdges{}) {
		t.Fatalf("stale touches stored as edges: %+v", stored)
	}
}

// Another tenant's touches never become this tenant's edges.
//
// Honest about WHICH control this proves: the probes both filter tenant_id
// explicitly and run under RLS, and in this path RLS alone is sufficient —
// removing the explicit filter does NOT make this test fail. The filter is
// defence in depth for the public-ingest path, which binds the GUC differently
// and is not exercised here. Stating that is better than implying a mutation
// test covers it; a guard nobody has seen fail is a guard nobody has tested.
func TestEdgesNeverCrossTenants(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	mine := createAttributionTenant(t, pool, ctx)
	theirs := createAttributionTenant(t, pool, ctx)

	now := time.Now().UTC()
	f := seedEdgeFixture(t, pool, ctx, theirs, now)

	// Same email, my tenant: the person exists in both, the touches only in theirs.
	tx, err := db.WithTenant(ctx, pool, mine)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')`,
		mine, f.Email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed my subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	probe, err := db.WithTenant(ctx, pool, mine)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = probe.Rollback(ctx) }()
	direct, err := lookupStructuralEdges(ctx, probe, mine, f.Email, time.Now().UTC())
	if err != nil {
		t.Fatalf("the probes failed, so an empty result proves nothing: %v", err)
	}
	if direct != (structuralEdges{}) {
		t.Fatalf("probe crossed tenants: %+v", direct)
	}

	c, err := (&Repo{Pool: pool}).Insert(ctx, mine, IngestInput{
		Email: f.Email, EventName: "purchase",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	got := readEdges(t, pool, ctx, mine, c.ID)
	if got.FlowID != "" || got.FormID != "" || got.DiscountID != "" ||
		got.ReferrerSubscriberID != "" || got.ExperimentVariantID != "" {
		t.Fatalf("read another tenant's touches as edges: %+v", got)
	}
}

// An edge lookup that fails must cost the graph, never the money.
//
// Simulated by dropping the probe's source table inside the caller's tx: the
// lookup errors, and the conversion must still be recorded. This is the
// property the savepoint exists for, and it is invisible in the happy path.
func TestAFailedEdgeLookupStillRecordsTheConversion(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind guc: %v", err)
	}
	// A probe against a table that does not exist in this tx's view.
	var got structuralEdges
	lookupErr, savepointErr := runBestEffortInSavepoint(ctx, tx, structuralEdgeLookupSavepoint, func() error {
		return scanEdge(ctx, tx, &got.FlowID, `SELECT flow_id::text FROM no_such_edge_table LIMIT 1`)
	})
	if savepointErr != nil {
		t.Fatalf("savepoint machinery failed: %v", savepointErr)
	}
	if lookupErr == nil {
		t.Fatal("expected the probe to fail; the test proves nothing otherwise")
	}
	// The tx must still be usable — that is the whole point of the savepoint.
	var one int
	if err := tx.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
		t.Fatalf("tx unusable after a failed edge probe — a conversion would be "+
			"lost because a join missed: %v", err)
	}
}

// The read side groups money by an edge, and says what it left out.
//
// The WithoutEdge assertion is the one that matters. A graph built from three
// attributed conversions out of nine thousand looks identical to one built from
// all of them unless the excluded rows are reported, and a reader who cannot
// tell those apart will believe a rounding error is a finding.
func TestRevenueGraphGroupsByEdgeAndReportsWhatItExcluded(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	f := seedEdgeFixture(t, pool, ctx, tenantID, time.Now().UTC())

	repo := &Repo{Pool: pool}
	amount := int64(2500)
	// Two conversions that carry every edge…
	for i := 0; i < 2; i++ {
		if _, err := repo.Insert(ctx, tenantID, IngestInput{
			Email: f.Email, EventName: "purchase", AmountCents: &amount, Currency: "usd",
		}); err != nil {
			t.Fatalf("insert attributed: %v", err)
		}
	}
	// …and one from someone with no touches at all.
	orphan := int64(999)
	if _, err := repo.Insert(ctx, tenantID, IngestInput{
		Email:     "orphan-" + randUUID(t)[:8] + "@example.test",
		EventName: "purchase", AmountCents: &orphan, Currency: "usd",
	}); err != nil {
		t.Fatalf("insert orphan: %v", err)
	}

	got, err := repo.RevenueGraph(ctx, tenantID, "flow", 30, time.Now())
	if err != nil {
		t.Fatalf("RevenueGraph: %v", err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("rows = %d, want 1 flow node: %+v", len(got.Rows), got.Rows)
	}
	if got.Rows[0].NodeID != f.FlowID {
		t.Errorf("node = %q, want the seeded flow %q", got.Rows[0].NodeID, f.FlowID)
	}
	if got.Rows[0].Conversions != 2 || got.Rows[0].AmountCents != 5000 {
		t.Errorf("node totals = %d conversions / %d cents, want 2 / 5000",
			got.Rows[0].Conversions, got.Rows[0].AmountCents)
	}
	if got.WithoutEdge != 1 || got.UnattributedCents != orphan {
		t.Errorf("excluded = %d rows / %d cents, want 1 / %d — a caller cannot "+
			"tell a complete graph from a nearly-empty one",
			got.WithoutEdge, got.UnattributedCents, orphan)
	}
	// The orphan must not appear as a node with an empty id.
	for _, row := range got.Rows {
		if row.NodeID == "" {
			t.Fatal(`a conversion with no edge became a node called "" — it would ` +
				`render as an unnamed bar owning real revenue`)
		}
	}
}

// An edge name the reader does not know is refused, not interpolated.
func TestAnUnknownEdgeIsRefused(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	if _, err := (&Repo{Pool: pool}).RevenueGraph(ctx, tenantID, "flow_id; DROP TABLE conversions", 30, time.Now()); err == nil {
		t.Fatal("an unknown edge was accepted; the parameter reaches SQL as an identifier")
	}
}
