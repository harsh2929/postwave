// SPDX-License-Identifier: AGPL-3.0-only
//
// segment_materializer_db_test.go — the five-minute membership refresher,
// run as the RLS-bound API role.
//
// segments is FORCE RLS keyed on app.tenant_id. The materialiser listed stale
// segments with one cross-tenant query and no tenant bound, so as postwave_app
// (NOBYPASSRLS, the staging and production API role) it saw zero rows on every
// tick and never refreshed anything. Run these with DATABASE_URL pointing at
// postwave_app; a superuser connection would pass the old code too.

package send_time_opt

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

func newMaterializerTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed materialiser test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedMaterializerTenant creates a tenant with two active subscribers and one
// archived subscriber whose emails carry marker, plus a segment matching all
// of them. Returns the tenant and segment ids.
func seedMaterializerTenant(t *testing.T, pool *pgxpool.Pool, includeArchived bool) (tenantID, segmentID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tenantID = uuid.NewString()
	marker := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "materializer-"+marker); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	for _, prefix := range []string{"one", "two", "gone"} {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, archived_at)
VALUES ($1::uuid, $2::citext, 'enabled', 'api', CASE WHEN $3 THEN now() ELSE NULL END)`,
			tenantID, prefix+"-"+marker+"@example.test", prefix == "gone"); err != nil {
			t.Fatalf("seed subscriber: %v", err)
		}
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast, include_archived)
VALUES ($1::uuid, $2, $3::jsonb, $4)
RETURNING id::text`, tenantID, "Materialised "+marker,
		`{"op":"condition","field":"email","comparator":"contains","value":"`+marker+`"}`, includeArchived).Scan(&segmentID); err != nil {
		t.Fatalf("seed segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		cleanup, err := db.WithTenant(cctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cctx) }()
		_, _ = cleanup.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cctx)
	})
	return tenantID, segmentID
}

type materializedState struct {
	cached     int
	lastCount  *int
	baselineAt *time.Time
}

func readMaterializedState(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID string) materializedState {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s materializedState
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM segment_subscribers WHERE tenant_id = $1::uuid AND segment_id = $2::uuid`,
		tenantID, segmentID).Scan(&s.cached); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT last_count, membership_baseline_at FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, segmentID).Scan(&s.lastCount, &s.baselineAt); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSegmentMaterializerSeesAndRefreshesSegmentsUnderRLS_DB(t *testing.T) {
	pool := newMaterializerTestPool(t)
	tenantID, segmentID := seedMaterializerTenant(t, pool, false)
	// A batch big enough that segments other tests left behind cannot push
	// this one out of the tick.
	m := &SegmentMaterializer{Repo: &Repo{Pool: pool}, Batch: 1_000_000}
	ctx := context.Background()

	stale, err := m.listStale(ctx)
	if err != nil {
		t.Fatalf("listStale: %v", err)
	}
	if !containsSegment(stale, tenantID, segmentID) {
		t.Fatalf("listStale (%d rows) does not include the never-materialised segment %s", len(stale), segmentID)
	}

	n, err := m.refresh(ctx, tenantID, segmentID)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	state := readMaterializedState(t, pool, tenantID, segmentID)
	if n != 2 || state.cached != 2 || state.lastCount == nil || *state.lastCount != 2 || state.baselineAt == nil {
		t.Fatalf("after refresh: wrote=%d cached=%d last_count=%v baseline=%v, want 2/2/2/set", n, state.cached, state.lastCount, state.baselineAt)
	}

	// Freshly baselined, so the next listing leaves it alone. (The tenant's
	// starter segments are still due; they are not this test's subject.)
	due, err := m.listTenantStale(ctx, tenantID, time.Now().UTC().Add(-m.freshFor()), m.batch())
	if err != nil {
		t.Fatalf("listTenantStale: %v", err)
	}
	if containsSegment(due, tenantID, segmentID) {
		t.Fatalf("a segment refreshed just now is still due: %+v", due)
	}
}

func TestSegmentMaterializerRecordsTheSegmentsOwnSize_DB(t *testing.T) {
	pool := newMaterializerTestPool(t)
	tenantID, segmentID := seedMaterializerTenant(t, pool, true)
	m := &SegmentMaterializer{Repo: &Repo{Pool: pool}}
	if _, err := m.refresh(context.Background(), tenantID, segmentID); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	state := readMaterializedState(t, pool, tenantID, segmentID)
	if state.cached != 2 {
		t.Fatalf("cached %d, want the 2 active subscribers", state.cached)
	}
	if state.lastCount == nil || *state.lastCount != 3 {
		t.Fatalf("last_count = %v, want 3 for an include-archived segment", state.lastCount)
	}
}

// A subscriber can enter a segment without any event reaching the event
// worker: a profile edit, an import, a list or tag change, a date rule coming
// true. The materialiser's rewrite is then the first to see them, and it used
// to fold them into the baseline without a word, so "Entered segment" never
// fired for them. It now forwards them like the event worker does.
func TestSegmentMaterializerForwardsSubscribersWhoEnteredWithoutAnEvent_DB(t *testing.T) {
	pool := newMaterializerTestPool(t)
	tenantID, segmentID := seedMaterializerTenant(t, pool, false)
	joins := &recordedJoins{}
	m := &SegmentMaterializer{Repo: &Repo{Pool: pool}, Forwarder: joins}
	ctx := context.Background()

	// The first rewrite only records the baseline.
	if _, err := m.refresh(ctx, tenantID, segmentID); err != nil {
		t.Fatalf("baseline refresh: %v", err)
	}
	if got := joins.settle(t, 0); len(got) != 0 {
		t.Fatalf("the baseline rewrite forwarded %+v", got)
	}

	// A new matching subscriber arrives by a path that enqueues nothing.
	newcomer := "newcomer-" + segmentMarker(t, pool, tenantID, segmentID) + "@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'import')`, tenantID, newcomer); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("add subscriber: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	n, err := m.refresh(ctx, tenantID, segmentID)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if n != 3 {
		t.Fatalf("cached %d, want 3", n)
	}
	got := joins.settle(t, 1)
	if len(got) != 1 || got[0].SubscriberEmail != newcomer || got[0].SegmentID != segmentID || got[0].TenantID != tenantID {
		t.Fatalf("forwarded %+v, want exactly the newcomer", got)
	}

	// Nothing changed since: the next rewrite forwards nobody.
	joins.reset()
	if _, err := m.refresh(ctx, tenantID, segmentID); err != nil {
		t.Fatalf("unchanged refresh: %v", err)
	}
	if got := joins.settle(t, 0); len(got) != 0 {
		t.Fatalf("an unchanged rewrite forwarded %+v", got)
	}
}

// segmentMarker reads back the marker the seeded segment matches on.
func segmentMarker(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var marker string
	if err := tx.QueryRow(ctx, `SELECT query_ast->>'value' FROM segments WHERE id = $1::uuid`, segmentID).Scan(&marker); err != nil {
		t.Fatalf("read marker: %v", err)
	}
	return marker
}

// recordedJoins records segment_joined forwards. Dispatch runs on a detached
// goroutine, so callers wait for the count they expect.
type recordedJoins struct {
	mu     sync.Mutex
	events []segments.SegmentJoinEvent
}

func (r *recordedJoins) ForwardSegmentJoined(_ context.Context, ev segments.SegmentJoinEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	return nil
}

func (r *recordedJoins) settle(t *testing.T, want int) []segments.SegmentJoinEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(r.snapshot()) < want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	// Leave room for a forward that should not have happened to show up.
	time.Sleep(150 * time.Millisecond)
	return r.snapshot()
}

func (r *recordedJoins) snapshot() []segments.SegmentJoinEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]segments.SegmentJoinEvent(nil), r.events...)
}

func (r *recordedJoins) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = nil
}

func containsSegment(list []staleSegment, tenantID, segmentID string) bool {
	for _, s := range list {
		if s.TenantID == tenantID && s.SegmentID == segmentID {
			return true
		}
	}
	return false
}

// staler puts never-baselined segments first and then the oldest baseline, so
// the per-tick batch drains fairly across tenants.
func TestStalerOrdersByBaseline(t *testing.T) {
	older := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	newer := older.Add(time.Hour)
	never := staleSegment{SegmentID: "never"}
	a := staleSegment{SegmentID: "older", BaselineAt: &older}
	b := staleSegment{SegmentID: "newer", BaselineAt: &newer}
	cases := []struct {
		x, y staleSegment
		want bool
	}{
		{never, a, true},
		{a, never, false},
		{a, b, true},
		{b, a, false},
		{never, never, false},
	}
	for _, tc := range cases {
		if got := staler(tc.x, tc.y); got != tc.want {
			t.Errorf("staler(%s, %s) = %v, want %v", tc.x.SegmentID, tc.y.SegmentID, got, tc.want)
		}
	}
}
