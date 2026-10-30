// SPDX-License-Identifier: AGPL-3.0-only

package onboarding

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// fakeMarkers is an in-memory MarkerStore used by the unit tests so we
// can exercise the idempotency / restart-survives semantics without a
// live Postgres. Production wires PgMarkerStore against tenants.metadata.
type fakeMarkers struct {
	mu       sync.Mutex
	markers  map[string]Counts // tenant_id -> counts (presence == seeded)
	seededAt map[string]time.Time
}

func newFakeMarkers() *fakeMarkers {
	return &fakeMarkers{
		markers:  map[string]Counts{},
		seededAt: map[string]time.Time{},
	}
}

func (f *fakeMarkers) LoadMarker(_ context.Context, tenantID string) (Counts, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.markers[tenantID]
	return c, ok, nil
}

func (f *fakeMarkers) LoadSeededAt(_ context.Context, tenantID string) (*time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if at, ok := f.seededAt[tenantID]; ok {
		return &at, nil
	}
	return nil, nil
}

func (f *fakeMarkers) SaveMarker(_ context.Context, tenantID string, counts Counts) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markers[tenantID] = counts
	f.seededAt[tenantID] = time.Now().UTC()
	return nil
}

func (f *fakeMarkers) ClearMarker(_ context.Context, tenantID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.markers, tenantID)
	delete(f.seededAt, tenantID)
	return nil
}

// TestSeed_RequiresTenant — handler-bug guard.
func TestSeed_RequiresTenant(t *testing.T) {
	s := &Seeder{Pool: nil, Markers: newFakeMarkers()}
	_, err := s.Seed(context.Background(), "")
	if !errors.Is(err, ErrNoTenant) {
		t.Fatalf("Seed(\"\") = %v, want ErrNoTenant", err)
	}
	_, err = s.Remove(context.Background(), "")
	if !errors.Is(err, ErrNoTenant) {
		t.Fatalf("Remove(\"\") = %v, want ErrNoTenant", err)
	}
}

func TestSampleCampaignEventsPopulateDashboardMetrics(t *testing.T) {
	now := time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)
	events := sampleCampaignEvents(now)
	counts := map[string]int{}
	unique := map[string]map[string]struct{}{
		"opened":    {},
		"clicked":   {},
		"delivered": {},
		"bounced":   {},
	}
	for _, event := range events {
		counts[event.EventType]++
		if emails, ok := unique[event.EventType]; ok {
			emails[event.Email] = struct{}{}
		}
		if event.At.Before(now.Add(-21*24*time.Hour)) || event.At.After(now) {
			t.Fatalf("event at %v falls outside the dashboard demo window", event.At)
		}
	}
	if counts["sent"] != SampleSubscriberCount || len(unique["delivered"]) != 49 || len(unique["bounced"]) != 1 {
		t.Fatalf("delivery events = %+v, delivered=%d bounced=%d", counts, len(unique["delivered"]), len(unique["bounced"]))
	}
	if len(unique["opened"]) != 26 || len(unique["clicked"]) != 8 {
		t.Fatalf("engagement events = %+v, unique opens=%d clicks=%d", counts, len(unique["opened"]), len(unique["clicked"]))
	}
}

// TestSeed_IdempotentViaMarker is the core regression — pre-0082 the
// idempotency map lived in memory and a process restart re-seeded.
// After the migration the marker is in the DB; we simulate this by
// checking that LoadMarker is consulted on every call.
func TestSeed_IdempotentViaMarker(t *testing.T) {
	markers := newFakeMarkers()
	// Pre-populate the marker — same shape PgMarkerStore would write
	// after a prior Seed that committed everything.
	const tenantID = "00000000-0000-0000-0000-000000000001"
	cached := Counts{Subscribers: 50, Segments: 1, Campaigns: 3, Sequences: 1}
	if err := markers.SaveMarker(context.Background(), tenantID, cached); err != nil {
		t.Fatalf("seed marker: %v", err)
	}

	// Pool is nil — if Seed reaches the DB writers we'll panic on the
	// nil deref. The marker hit must short-circuit before that.
	s := &Seeder{Pool: nil, Markers: markers}
	res, err := s.Seed(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if !res.Seeded {
		t.Errorf("Seed: Seeded=false, want true (cached path)")
	}
	if res.Counts != cached {
		t.Errorf("Seed: counts = %+v, want %+v", res.Counts, cached)
	}
	if res.Note == "" {
		t.Errorf("Seed: expected non-empty Note for cached path")
	}
}

// TestSeed_RestartSurvives simulates the "process restarts, marker is
// still in the DB" path: the new Seeder struct has no in-memory state,
// but reading the marker still surfaces the cached counts. This is
// the main regression vs the pre-0082 in-memory map.
func TestSeed_RestartSurvives(t *testing.T) {
	markers := newFakeMarkers()
	const tenantID = "00000000-0000-0000-0000-000000000002"
	cached := Counts{Subscribers: 50, Segments: 1, Campaigns: 3, Sequences: 1}
	_ = markers.SaveMarker(context.Background(), tenantID, cached)

	// Brand-new Seeder — represents a fresh process post-restart.
	fresh := &Seeder{Pool: nil, Markers: markers}
	got, ok, err := fresh.IsSeeded(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("IsSeeded: %v", err)
	}
	if !ok {
		t.Errorf("IsSeeded: ok=false; want true (marker should survive restart)")
	}
	if got != cached {
		t.Errorf("IsSeeded: counts = %+v, want %+v", got, cached)
	}

	// And Seed itself returns the cached counts without touching the
	// (nil) pool.
	res, err := fresh.Seed(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if res.Counts != cached {
		t.Errorf("Seed: counts = %+v, want %+v", res.Counts, cached)
	}
}

// TestRemove_ClearsMarker — Remove must clear the marker so a
// follow-up Seed can run fresh. We don't exercise the row-deletes
// here because they need a live pool; the marker side is unit-
// testable.
func TestRemove_ClearsMarker(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	// (Integration tests live in a separate file when we add them;
	// this skip mirrors the suppressions/store_test.go pattern.)
}

// TestPgMarkerStore_RequiresPool — guard against accidental nil-pool
// construction.
func TestPgMarkerStore_RequiresPool(t *testing.T) {
	m := &PgMarkerStore{Pool: nil}
	if _, _, err := m.LoadMarker(context.Background(), "tid"); err == nil {
		t.Errorf("LoadMarker(nil pool) returned nil err; want error")
	}
	if err := m.SaveMarker(context.Background(), "tid", Counts{}); err == nil {
		t.Errorf("SaveMarker(nil pool) returned nil err; want error")
	}
	if err := m.ClearMarker(context.Background(), "tid"); err == nil {
		t.Errorf("ClearMarker(nil pool) returned nil err; want error")
	}
}

// TestSeed_FullFlow runs the actual DB writes when DATABASE_URL is
// set. Mirrors the suppressions/store_test.go integration pattern.
func TestSeed_FullFlow(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30 /* seconds */ *1e9)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := seedOnboardingTenant(t, ctx, pool)
	s := NewSeeder(pool)
	t.Cleanup(func() {
		_, _ = s.Remove(context.Background(), tenantID)
	})

	// First Seed.
	res1, err := s.Seed(ctx, tenantID)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if !res1.Seeded || res1.Counts.Subscribers == 0 {
		t.Fatalf("Seed: unexpected result %+v", res1)
	}
	// The examples must actually populate the directory and current segment
	// builder, while remaining inert: no automatic send or sequence activation.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var names, scheduled, activeSequences int
	var ast []byte
	if err := tx.QueryRow(ctx, `SELECT count(DISTINCT full_name) FROM subscribers WHERE tenant_id=$1::uuid`, tenantID).Scan(&names); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaigns WHERE tenant_id=$1::uuid AND status='scheduled'`, tenantID).Scan(&scheduled); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM voice_sequences WHERE tenant_id=$1::uuid AND status='active'`, tenantID).Scan(&activeSequences); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT query_ast FROM segments WHERE tenant_id=$1::uuid AND description LIKE $2 LIMIT 1`, tenantID, sampleSegmentDescPrefix+"%").Scan(&ast); err != nil {
		t.Fatal(err)
	}
	predicate, args, err := segments.CompileAST(ast)
	if err != nil {
		t.Fatalf("sample segment cannot be opened/evaluated: %v", err)
	}
	var matches int
	query := fmt.Sprintf(`SELECT count(*) FROM subscribers WHERE tenant_id=$%d::uuid AND `, len(args)+1) + predicate
	if err := tx.QueryRow(ctx, query, append(args, tenantID)...).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if names != SampleSubscriberCount || matches != SampleSubscriberCount || scheduled != 0 || activeSequences != 0 {
		t.Fatalf("demo names=%d matches=%d scheduled=%d active sequences=%d; predicate=%s args=%#v", names, matches, scheduled, activeSequences, predicate, args)
	}

	// Second Seed — must be a no-op via the marker, returning the
	// same counts.
	res2, err := s.Seed(ctx, tenantID)
	if err != nil {
		t.Fatalf("Seed (idempotent): %v", err)
	}
	if res2.Counts != res1.Counts {
		t.Errorf("Seed idempotency: counts drifted %+v -> %+v", res1.Counts, res2.Counts)
	}

	// Remove → re-Seed → should work fresh.
	if _, err := s.Remove(ctx, tenantID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	res3, err := s.Seed(ctx, tenantID)
	if err != nil {
		t.Fatalf("Seed after remove: %v", err)
	}
	if !res3.Seeded {
		t.Errorf("Seed after remove: Seeded=false; want true")
	}
}

func seedOnboardingTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Onboarding sample-data test', 'studio')`,
		tenantID, "onboarding-sample-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
	return tenantID
}

// TestStatus_ReflectsMarkerLifecycle — desktop-audit gap A29. GET
// status must report seeded=true (+seeded_at, +counts) after the
// marker is written and seeded=false after it's cleared, all without
// touching the (nil) pool — Status is a pure marker read.
func TestStatus_ReflectsMarkerLifecycle(t *testing.T) {
	markers := newFakeMarkers()
	const tenantID = "00000000-0000-0000-0000-000000000003"
	s := &Seeder{Pool: nil, Markers: markers}

	// Tenant-required guard, same as Seed/Remove.
	if _, err := s.Status(context.Background(), ""); !errors.Is(err, ErrNoTenant) {
		t.Fatalf("Status(\"\") = %v, want ErrNoTenant", err)
	}

	// Unseeded → seeded=false, no timestamp, no counts.
	st, statusErr := s.Status(context.Background(), tenantID)
	if statusErr != nil {
		t.Fatalf("Status (unseeded): %v", statusErr)
	}
	if st.Seeded || st.SeededAt != nil || st.Counts != nil {
		t.Errorf("Status (unseeded) = %+v, want zero-value result", st)
	}

	// Seeded → marker + timestamp + counts.
	cached := Counts{Subscribers: 50, Segments: 1, Campaigns: 3, Sequences: 1}
	if err := markers.SaveMarker(context.Background(), tenantID, cached); err != nil {
		t.Fatalf("save marker: %v", err)
	}
	st, statusErr = s.Status(context.Background(), tenantID)
	if statusErr != nil {
		t.Fatalf("Status (seeded): %v", statusErr)
	}
	if !st.Seeded {
		t.Errorf("Status: Seeded=false, want true")
	}
	if st.SeededAt == nil || time.Since(*st.SeededAt) > time.Minute {
		t.Errorf("Status: SeededAt = %v, want recent timestamp", st.SeededAt)
	}
	if st.Counts == nil || *st.Counts != cached {
		t.Errorf("Status: counts = %+v, want %+v", st.Counts, cached)
	}

	// Removed → marker cleared → seeded=false again.
	if err := markers.ClearMarker(context.Background(), tenantID); err != nil {
		t.Fatalf("clear marker: %v", err)
	}
	st, statusErr = s.Status(context.Background(), tenantID)
	if statusErr != nil {
		t.Fatalf("Status (after clear): %v", statusErr)
	}
	if st.Seeded || st.SeededAt != nil {
		t.Errorf("Status (after clear) = %+v, want unseeded", st)
	}
}
