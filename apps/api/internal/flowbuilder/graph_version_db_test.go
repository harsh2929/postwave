// SPDX-License-Identifier: AGPL-3.0-only

package flowbuilder

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The version a run enrolled under must survive an edit to the flow.
//
// That is the whole point: an operator publishes v2 while runs from v1 are
// mid-journey, and the question "which graph is this run executing" has to keep
// answering v1. A column that re-derived the answer from the flow's current
// state would agree with the edit and lose the fact.

func flowVersionPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedFlowVersion creates a tenant, a subscriber and one published version,
// returning the ids a run needs.
func seedFlowVersion(t *testing.T, pool *db.Pool, ctx context.Context) (tenantID, flowID, subscriberID, versionID string) {
	t.Helper()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'flowver', 'studio')`,
		tenantID, "flowver-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	subscriberID = uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'import')`,
		subscriberID, tenantID, "flowver-"+subscriberID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	flowID = uuid.NewString()
	// flow_runs.flow_id references automation_journeys; the version rows hang
	// off the same id via journey_id.
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_journeys (id, tenant_id, name, status)
VALUES ($1::uuid, $2::uuid, 'Version test', 'active')`, flowID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed journey: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_flow_versions (tenant_id, journey_id, version, status, graph)
VALUES ($1::uuid, $2::uuid, 1, 'published', '{"nodes":[{"id":"a"}]}'::jsonb)
RETURNING id::text`, tenantID, flowID).Scan(&versionID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed version: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		for _, q := range []string{
			`DELETE FROM flow_runs WHERE tenant_id = $1::uuid`,
			`DELETE FROM automation_flow_versions WHERE tenant_id = $1::uuid`,
			`DELETE FROM automation_journeys WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			_, _ = c.Exec(bg, q, tenantID)
		}
		_ = c.Commit(bg)
	})
	return tenantID, flowID, subscriberID, versionID
}

func insertRun(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, flowID, subscriberID, versionID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runID string
	if err := tx.QueryRow(ctx, `
INSERT INTO flow_runs (tenant_id, flow_id, subscriber_id, status, scheduled_at, graph_version_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued', now(), $4::uuid)
RETURNING id::text`, tenantID, flowID, subscriberID, graphVersionArg(versionID)).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return runID
}

func readRunVersion(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, runID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(graph_version_id::text, '') FROM flow_runs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, runID).Scan(&got); err != nil {
		t.Fatalf("read run: %v", err)
	}
	return got
}

func TestARunStaysBoundToTheVersionItEnrolledUnder(t *testing.T) {
	pool := flowVersionPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID, flowID, subscriberID, v1 := seedFlowVersion(t, pool, ctx)
	runID := insertRun(t, pool, ctx, tenantID, flowID, subscriberID, v1)

	// The operator publishes v2 while the run is mid-journey.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE automation_flow_versions SET status = 'archived'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, v1); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_flow_versions (tenant_id, journey_id, version, status, graph)
VALUES ($1::uuid, $2::uuid, 2, 'published', '{"nodes":[{"id":"b"}]}'::jsonb)`,
		tenantID, flowID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if got := readRunVersion(t, pool, ctx, tenantID, runID); got != v1 {
		t.Fatalf("run now points at %q, want the version it enrolled under (%q). "+
			"An in-flight run must not silently adopt a graph its trigger never "+
			"evaluated", got, v1)
	}
}

func TestTheEnrolledVersionCannotBeDeletedAwayFromARun(t *testing.T) {
	// Deleting the evidence out from under a completed run is how you get a
	// history nobody can explain.
	pool := flowVersionPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID, flowID, subscriberID, v1 := seedFlowVersion(t, pool, ctx)
	insertRun(t, pool, ctx, tenantID, flowID, subscriberID, v1)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
DELETE FROM automation_flow_versions WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, v1)
	if err == nil {
		t.Fatal("the version a live run points at was deleted; that run can no " +
			"longer say what graph it followed")
	}
}

func TestARunWithNoKnownVersionIsNullNotZero(t *testing.T) {
	pool := flowVersionPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID, flowID, subscriberID, _ := seedFlowVersion(t, pool, ctx)
	runID := insertRun(t, pool, ctx, tenantID, flowID, subscriberID, "")

	if got := readRunVersion(t, pool, ctx, tenantID, runID); got != "" {
		t.Fatalf("an unknown version became %q — 'unknown' and 'version X' are "+
			"different facts", got)
	}
}

// Enrollment must RESOLVE the version, not merely accept one.
//
// Migration 1875 added `flow_runs.graph_version_id`, the INSERT accepts it, and
// `RunEnqueueRequest` carries it — and NOTHING populated it. Every run stamped
// NULL, so the question the column exists to answer ("which graph is this run
// executing?") had exactly the same answer as before it was added. Column,
// field and INSERT all present; the one line that supplies a value, absent.

func TestEnrollmentResolvesTheFlowsPublishedVersion(t *testing.T) {
	pool := flowVersionPool(t)
	ctx := context.Background()
	tenantID, flowID, _, versionID := seedFlowVersion(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	got, err := resolveGraphVersion(ctx, tx, tenantID, flowID, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != versionID {
		t.Errorf("resolved %q, want the published version %q — a run stamped with "+
			"nothing cannot say which graph it executed, which is the whole "+
			"question the column was added to answer", got, versionID)
	}
}

func TestACallerSuppliedVersionWins(t *testing.T) {
	// A replay or backfill knows which graph it is reconstructing. Overwriting
	// that with "whatever is published now" would silently relabel history.
	pool := flowVersionPool(t)
	ctx := context.Background()
	tenantID, flowID, _, versionID := seedFlowVersion(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	supplied := "11111111-2222-3333-4444-555555555555"
	got, err := resolveGraphVersion(ctx, tx, tenantID, flowID, supplied)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got == versionID {
		t.Error("the caller's explicit version was overwritten with the currently " +
			"published one, relabelling a replay as something it was not")
	}
	if got != supplied {
		t.Errorf("resolved %q, want the supplied %q", got, supplied)
	}
}

func TestAFlowWithNoPublishedVersionResolvesToEmpty(t *testing.T) {
	// NULL stays honest. Inventing a version — the newest draft, say — would
	// assert exactly the thing the column exists to stop guessing at.
	pool := flowVersionPool(t)
	ctx := context.Background()
	tenantID, flowID, _, _ := seedFlowVersion(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Unpublish everything for this flow.
	if _, err := tx.Exec(ctx, `
UPDATE automation_flow_versions SET status = 'draft'
 WHERE tenant_id = $1::uuid AND journey_id = $2::uuid`, tenantID, flowID); err != nil {
		t.Fatalf("unpublish: %v", err)
	}

	got, err := resolveGraphVersion(ctx, tx, tenantID, flowID, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "" {
		t.Errorf("resolved %q for a flow with nothing published; NULL is the "+
			"honest answer and the column is nullable for exactly this case", got)
	}
}

func TestTheNEWESTPublishedVersionWins(t *testing.T) {
	// Publishing is an UPDATE that archives the previous row, but a partial
	// failure or a legacy row can leave two marked published. Ordering by
	// version descending means enrollment picks the one a subscriber would
	// actually run, not whichever the planner returned first.
	pool := flowVersionPool(t)
	ctx := context.Background()
	tenantID, flowID, _, _ := seedFlowVersion(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var newer string
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_flow_versions (tenant_id, journey_id, version, status, graph)
VALUES ($1::uuid, $2::uuid, 2, 'published', '{"nodes":[{"id":"b"}]}'::jsonb)
RETURNING id::text`, tenantID, flowID).Scan(&newer); err != nil {
		t.Fatalf("seed newer version: %v", err)
	}

	got, err := resolveGraphVersion(ctx, tx, tenantID, flowID, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != newer {
		t.Errorf("resolved %q, want the newest published version %q", got, newer)
	}
}
