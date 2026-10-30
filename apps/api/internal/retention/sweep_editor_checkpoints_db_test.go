// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/editorcheckpoint"
)

// checkpointSweepPrivacyStub keeps every OTHER retention class inert so this
// test observes one thing. The days are deliberately enormous rather than zero:
// zero means "delete everything older than now" for several classes, which
// would make an unrelated sweep failure look like this one's result.
type checkpointSweepPrivacyStub struct{}

func (checkpointSweepPrivacyStub) EmailEventRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) UnsubscribedSubscriberRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) EngagementEventRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) InboundEmailRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) WebhookDeliveryRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) FormSubmissionRetentionDays(context.Context, string) (int, error) {
	return 3650, nil
}
func (checkpointSweepPrivacyStub) ExportGraceDays(context.Context, string) (int, error) {
	return 3650, nil
}

// checkpointTestPools opens the app-role pool the sweeper runs on plus the
// admin pool used only to create and drop the tenant rows.
func checkpointTestPools(t *testing.T) (app, admin *pgxpool.Pool) {
	t.Helper()
	appURL := os.Getenv("DATABASE_URL")
	if appURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed editor checkpoint retention test")
	}
	ctx := context.Background()
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect app pool: %v", err)
	}
	t.Cleanup(app.Close)
	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = appURL
	}
	admin, err = pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect seed pool: %v", err)
	}
	t.Cleanup(admin.Close)
	return app, admin
}

// seedCheckpointTenant creates one tenant and removes it (and, by cascade, its
// checkpoints) afterwards.
func seedCheckpointTenant(t *testing.T, admin *pgxpool.Pool, label string) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin %s tenant seed: %v", label, err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("scope %s tenant seed: %v", label, err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'checkpoint-retention-test', $2, 'studio')`,
		tenantID, label+"-"+tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed %s tenant: %v", label, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit %s tenant seed: %v", label, err)
	}
	// The teardown binds the tenant, as the seed does. In CI
	// POSTWAVE_ADMIN_DATABASE_URL is unset, so "admin" is the application role,
	// and the tenants DELETE policy sees only the row whose id equals
	// app.tenant_id. The bare `admin.Exec` DELETE this replaces matched no row,
	// reported no error, and left every seeded tenant in the shared database.
	t.Cleanup(func() { deleteRetentionTestTenant(t, admin, tenantID) })
	return tenantID
}

// seedCheckpoint inserts one draft with an explicit age. `age` is how long ago
// it was last touched; the column defaults to now() and the whole cutoff turns
// on that value, so nothing here may rely on the default.
func seedCheckpoint(t *testing.T, pool *pgxpool.Pool, tenantID, userID, entityID string, age time.Duration) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open checkpoint seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO editor_checkpoints (tenant_id, user_id, entity_key, entity_id, content, updated_at)
VALUES ($1::uuid, $2::uuid, 'campaign', $3, '{"subject":"a half-written thought"}'::jsonb,
        now() - ($4::double precision * interval '1 second'))`,
		tenantID, userID, entityID, age.Seconds()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed checkpoint %s: %v", entityID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit checkpoint seed %s: %v", entityID, err)
	}
}

// survivingCheckpoints lists what is left for one tenant, read under that
// tenant's own scope.
func survivingCheckpoints(t *testing.T, pool *pgxpool.Pool, tenantID string) []string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open checkpoint verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT entity_id FROM editor_checkpoints WHERE tenant_id = $1::uuid ORDER BY entity_id`, tenantID)
	if err != nil {
		t.Fatalf("read surviving checkpoints: %v", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var entityID string
		if err := rows.Scan(&entityID); err != nil {
			t.Fatalf("scan surviving checkpoint: %v", err)
		}
		out = append(out, entityID)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate surviving checkpoints: %v", err)
	}
	return out
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// TestSweepOnceForTenant_ExpiresAbandonedEditorCheckpoints drives the tenant
// FAN-OUT rather than sweepEditorCheckpoints directly, and that choice is the
// point of the test.
//
// The defect being closed was never a broken DELETE — the package sweep worked
// and had passing tests. It had no caller. A test that invoked the sweep
// function would have been green throughout the entire period the table was
// growing without bound, which is the same shape as the mechanism it is
// testing: correct, and never reached. Going through SweepOnceForTenant means
// removing the registration fails this test.
//
// The fixture pins three separate musts, each of which was previously either
// unpinned or claimed-but-not-shown:
//
//   - TWO stale drafts under DIFFERENT users must both go. One stale row proves
//     nothing about reach past a single user — it would be deleted just as
//     happily by a sweep that only ever touched one person's drafts, which is
//     the shape the RESTRICTIVE owner_isolation policy would impose if the
//     sweep ever acquired an acting user.
//   - A freshly-touched draft must survive. A sweep that takes live work is
//     worse than no sweep.
//   - A SECOND TENANT's equally stale draft must survive. That is the must-not,
//     and nothing pinned it: a sweep that dropped its tenant predicate would
//     have passed every earlier assertion here while deleting the neighbours.
//
// BatchSize is pinned to 1 so the two stale rows cannot be cleared by one
// statement: a sweep that takes a batch and returns without looping leaves
// abandoned-2 behind and fails here. The opposite regression — dropping the
// bound entirely — still passes this test, so it is pinned separately by
// TestTheEditorCheckpointSweepStopsAtItsBatchCap.
func TestSweepOnceForTenant_ExpiresAbandonedEditorCheckpoints(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()

	tenantID := seedCheckpointTenant(t, admin, "checkpoint-retention")
	neighbourID := seedCheckpointTenant(t, admin, "checkpoint-neighbour")

	stale := editorcheckpoint.SweepAge + 24*time.Hour
	// Two people who never came back, so the sweep is shown to reach past a
	// single user rather than merely past a single row.
	seedCheckpoint(t, pool, tenantID, uuid.NewString(), "abandoned-1", stale)
	seedCheckpoint(t, pool, tenantID, uuid.NewString(), "abandoned-2", stale)
	// Someone still typing.
	seedCheckpoint(t, pool, tenantID, uuid.NewString(), "live-1", 0)
	// A different tenant, equally abandoned, that this run has no business
	// touching.
	seedCheckpoint(t, pool, neighbourID, uuid.NewString(), "neighbour-abandoned", stale)

	sweeper := &Sweeper{Pool: pool, Privacy: checkpointSweepPrivacyStub{}, BatchSize: 1}
	purged, err := sweeper.SweepOnceForTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("SweepOnceForTenant: %v", err)
	}
	if purged["editor_checkpoints"] != 2 {
		t.Fatalf("purged[editor_checkpoints] = %d, want 2 — either the class is not in "+
			"the fan-out, or the sweep stopped after one batch (got %v)",
			purged["editor_checkpoints"], purged)
	}

	if survivors := survivingCheckpoints(t, pool, tenantID); !sameStrings(survivors, []string{"live-1"}) {
		t.Fatalf("checkpoints after sweep = %v, want only the freshly-touched live-1", survivors)
	}
	if survivors := survivingCheckpoints(t, pool, neighbourID); !sameStrings(survivors, []string{"neighbour-abandoned"}) {
		t.Fatalf("the neighbouring tenant's checkpoints = %v, want its own abandoned draft "+
			"untouched — sweeping one tenant deleted another tenant's drafts", survivors)
	}
}

// TestTheEditorCheckpointSweepStopsAtItsBatchCap pins the bound itself.
//
// batchSize()/maxBatchesPerTenant() exist, per raw_payloads.go:38-43, "so we
// don't take long-lived locks on a hot table". This class delegated to a single
// unbounded DELETE, and an unbounded DELETE passes every "the stale rows are
// gone" assertion — it deletes MORE, not less. The only way to catch it is to
// cap the work and require the sweep to leave the remainder for the next tick.
//
// One batch of one row against three stale drafts: exactly one must go. A sweep
// that ignores the cap clears all three; a sweep that issues one unbounded
// statement clears all three.
func TestTheEditorCheckpointSweepStopsAtItsBatchCap(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()
	tenantID := seedCheckpointTenant(t, admin, "checkpoint-batch-cap")

	stale := editorcheckpoint.SweepAge + 24*time.Hour
	for _, entityID := range []string{"abandoned-1", "abandoned-2", "abandoned-3"} {
		seedCheckpoint(t, pool, tenantID, uuid.NewString(), entityID, stale)
	}

	sweeper := &Sweeper{
		Pool:                pool,
		Privacy:             checkpointSweepPrivacyStub{},
		BatchSize:           1,
		MaxBatchesPerTenant: 1,
	}
	purged, err := sweeper.SweepOnceForTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("SweepOnceForTenant: %v", err)
	}
	if purged["editor_checkpoints"] != 1 {
		t.Fatalf("purged[editor_checkpoints] = %d with BatchSize=1 and "+
			"MaxBatchesPerTenant=1, want 1 — the sweep is not honouring the batch "+
			"bound, so a tenant's whole abandoned backlog goes in one transaction "+
			"(rows are up to 256 KiB each and the cutoff index is not "+
			"tenant-prefixed)", purged["editor_checkpoints"])
	}
	if survivors := survivingCheckpoints(t, pool, tenantID); len(survivors) != 2 {
		t.Fatalf("checkpoints after a one-batch sweep = %v, want two left for the "+
			"next tick", survivors)
	}
}

// TestListTenants_FindsATenantThatOnlyHasEditorCheckpoints pins the half of the
// wiring the fan-out test cannot see.
//
// SweepOnceForTenant is handed a tenant id. The background goroutine is not: it
// sweeps only what listTenants returns, and listTenants unions the tables each
// class prunes. A class whose table is missing from that union runs for every
// tenant that happens to be discovered through some OTHER table and never for
// the one that has nothing else left — which is exactly the tenant that
// offboarded its audience and kept its drafts, the GDPR case the sweep exists
// for. This tenant deliberately has no subscribers, no events, no exports: one
// abandoned draft and nothing else.
func TestListTenants_FindsATenantThatOnlyHasEditorCheckpoints(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()

	tenantID := seedCheckpointTenant(t, admin, "checkpoint-discovery")
	seedCheckpoint(t, pool, tenantID, uuid.NewString(), "only-a-draft",
		editorcheckpoint.SweepAge+24*time.Hour)

	sweeper := &Sweeper{Pool: pool, Privacy: checkpointSweepPrivacyStub{}}
	tenants, err := sweeper.listTenants(ctx)
	if err != nil {
		t.Fatalf("listTenants: %v", err)
	}
	for _, id := range tenants {
		if id == tenantID {
			return
		}
	}
	t.Fatalf("tenant %s holds a %v-old editor checkpoint and nothing else, and tenant "+
		"discovery did not return it: the scheduled sweeper never visits it, so the "+
		"class only ever fires for tenants that happen to be discovered through some "+
		"other table", tenantID, editorcheckpoint.SweepAge+24*time.Hour)
}

// TestTheSweepAgeIsEncodedInAFormPostgresAccepts covers the exported surface the
// sweeper calls into.
//
// editorcheckpoint.SweepAge is 336h and renders as an interval Postgres parses,
// so this never fired in production — but the method takes an arbitrary
// time.Duration, and Go renders sub-second durations with units Postgres
// rejects outright: '500µs'::interval and '100ns'::interval are both errors.
// Sending the age as a second count removes the unit spelling from the wire, so
// the magnitude of the duration stops being able to break the query.
func TestTheSweepAgeIsEncodedInAFormPostgresAccepts(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()
	repo := &editorcheckpoint.Repo{Pool: pool}

	for _, age := range []time.Duration{500 * time.Microsecond, 100 * time.Nanosecond} {
		t.Run(age.String(), func(t *testing.T) {
			tenantID := seedCheckpointTenant(t, admin, "checkpoint-age")
			seedCheckpoint(t, pool, tenantID, uuid.NewString(), "old", time.Hour)

			n, err := repo.SweepOlderThan(ctx, tenantID, age)
			if err != nil {
				t.Fatalf("SweepOlderThan(%v) = %v; a duration Go renders with a unit "+
					"Postgres cannot parse reaches the driver as an opaque error "+
					"from inside a DELETE", age, err)
			}
			if n != 1 {
				t.Fatalf("SweepOlderThan(%v) swept %d, want the one hour-old draft", age, n)
			}
		})
	}
}

// A sweep age of zero reads as "no minimum age" and means "delete everything",
// including the paragraph someone is in the middle of typing.
func TestANonPositiveSweepAgeIsRefusedRatherThanDeletingEverything(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()
	repo := &editorcheckpoint.Repo{Pool: pool}
	tenantID := seedCheckpointTenant(t, admin, "checkpoint-zero-age")
	seedCheckpoint(t, pool, tenantID, uuid.NewString(), "still-being-typed", 0)

	for _, age := range []time.Duration{0, -time.Hour} {
		n, err := repo.SweepOlderThan(ctx, tenantID, age)
		if !errors.Is(err, editorcheckpoint.ErrInvalidSweepAge) {
			t.Fatalf("SweepOlderThan(%v) = (%d, %v), want ErrInvalidSweepAge", age, n, err)
		}
	}
	if survivors := survivingCheckpoints(t, pool, tenantID); !sameStrings(survivors, []string{"still-being-typed"}) {
		t.Fatalf("checkpoints after a zero-age sweep = %v, want the live draft intact", survivors)
	}
}

// deleteRetentionTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteRetentionTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteRetentionTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteRetentionTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
