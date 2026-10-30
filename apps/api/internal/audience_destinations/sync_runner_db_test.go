// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the ghost-source guard in sync_runner.go. Skip
// cleanly without DATABASE_URL, matching the project-wide pg-backed
// test convention (outbound_webhooks/store_test.go).
package audience_destinations

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedOperationSafetySegment(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var segmentID string
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, '{"op":"and","children":[]}'::jsonb)
RETURNING id::text`, tenantID, fmt.Sprintf("audience-operation-%d", time.Now().UnixNano())).Scan(&segmentID); err != nil {
		t.Fatalf("seed operation segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit operation segment: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, segmentID)
		_ = cleanup.Commit(context.Background())
	})
	return segmentID
}

func seedOperationSafetySync(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID string, schedule string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var syncID string
	if err := tx.QueryRow(ctx, `
INSERT INTO audience_syncs
       (tenant_id, name, segment_id, destination_type, destination_url,
        destination_secret, schedule, enabled)
VALUES ($1::uuid, $2, $3::uuid, 'webhook', 'https://receiver.example.test',
        'test-secret', $4, true)
RETURNING id::text`, tenantID, fmt.Sprintf("operation-sync-%d", time.Now().UnixNano()), segmentID, schedule).Scan(&syncID); err != nil {
		t.Fatalf("seed audience sync: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audience sync: %v", err)
	}
	return syncID
}

func newSyncRunnerTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed audience sync test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSyncTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	var tenantExists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&tenantExists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !tenantExists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'audience-sync-source-test', 'audience-sync-source-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestVerifySourceExistsSegment pins both halves of the segment check:
// a live segments row passes, a missing one fails the run with the
// operator-facing "no longer exists" error.
func TestVerifySourceExistsSegment(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)

	sr := &SyncRunner{Repo: &Repo{Pool: pool}}

	// Missing segment → clear failure.
	err := sr.verifySourceExists(ctx, tenantID, &Sync{
		Source: SyncSource{SegmentID: strPtr("11111111-2222-4333-8444-555555555555")},
	})
	if err == nil || !strings.Contains(err.Error(), "source segment no longer exists") {
		t.Fatalf("missing segment: err = %v, want 'source segment no longer exists'", err)
	}

	// Live segment → passes.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var segID string
	segName := fmt.Sprintf("ghost-source-test-%d", time.Now().UnixNano())
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, '{"op":"and","children":[]}'::jsonb)
RETURNING id::text`, tenantID, segName).Scan(&segID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit segment seed: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `DELETE FROM segments WHERE id::text = $1`, segID)
		_ = tx.Commit(ctx)
	})
	if err := sr.verifySourceExists(ctx, tenantID, &Sync{
		Source: SyncSource{SegmentID: &segID},
	}); err != nil {
		t.Fatalf("live segment: verifySourceExists = %v, want nil", err)
	}
}

// TestVerifySourceExistsListMissing pins the list half: a list uuid
// with no live mapping must fail the run. (The positive case needs the
// engine-owned lists table populated, which only full-stack
// environments have — the negative case is the regression that
// matters: it is what used to record a fake 'succeeded' run.)
func TestVerifySourceExistsListMissing(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)

	sr := &SyncRunner{Repo: &Repo{Pool: pool}}
	err := sr.verifySourceExists(ctx, tenantID, &Sync{
		Source: SyncSource{ListID: strPtr("99999999-8888-4777-8666-555555555555")},
	})
	if err != nil && strings.Contains(err.Error(), "42P01") {
		// `lists` is owned by the AGPL engine, not by these migrations, so a
		// migrations-only database genuinely does not have it. That is an
		// ENVIRONMENT limit — this machine cannot run the test — and not a
		// fixture that failed, which is why it stays a Skip while every seed
		// failure in this sweep became a Fatal.
		t.Skip("engine-owned `lists` table is not available on this database; " +
			"run against a database that also has the engine schema")
	}
	if err == nil || !strings.Contains(err.Error(), "source list no longer exists") {
		t.Fatalf("missing list: err = %v, want 'source list no longer exists'", err)
	}

	// Ghost case proper: a list_id_map row whose engine lists row is gone
	// (the map survives list deletion) must also fail. Best-effort — the
	// fork's lists schema varies by environment, so an unseedable lists
	// table just ends the test after the (already passing) missing-map
	// assertion above.
	const listUUID = "99999999-8888-4777-8666-666666666666"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var bigintID int64
	if err := tx.QueryRow(ctx,
		`INSERT INTO lists (tenant_id, name) VALUES ($1::uuid, 'ghost-source-test') RETURNING id`,
		tenantID).Scan(&bigintID); err != nil {
		_ = tx.Rollback(ctx)
		t.Logf("cannot seed engine lists row in this environment (%v); ghost-case subassertion skipped", err)
		return
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listUUID, bigintID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed list_id_map: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list seed: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `DELETE FROM list_id_map WHERE postwave_uuid = $1::uuid`, listUUID)
		_, _ = tx.Exec(ctx, `DELETE FROM lists WHERE id = $1`, bigintID)
		_ = tx.Commit(ctx)
	})

	// Live list + map → passes.
	if err := sr.verifySourceExists(ctx, tenantID, &Sync{
		Source: SyncSource{ListID: strPtr(listUUID)},
	}); err != nil {
		t.Fatalf("live list: verifySourceExists = %v, want nil", err)
	}

	// Delete the engine row (map survives, mirroring a real list delete):
	// the sync must now fail.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM lists WHERE id = $1`, bigintID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("delete lists row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit lists delete: %v", err)
	}
	err = sr.verifySourceExists(ctx, tenantID, &Sync{
		Source: SyncSource{ListID: strPtr(listUUID)},
	})
	if err == nil || !strings.Contains(err.Error(), "source list no longer exists") {
		t.Fatalf("ghost list (map row, no engine row): err = %v, want 'source list no longer exists'", err)
	}
}

func TestDurableSyncOperationClaimAndReplay(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)
	segmentID := seedOperationSafetySegment(t, pool, tenantID)
	syncID := seedOperationSafetySync(t, pool, tenantID, segmentID, ScheduleManual)
	repo := &Repo{Pool: pool}

	key := manualOperationKey("durable-retry")
	claim, err := repo.beginSyncOperation(ctx, tenantID, syncID, key, operationTriggerManual, "", false, false)
	if err != nil {
		t.Fatalf("begin operation: %v", err)
	}
	if !claim.Created || claim.Run == nil || claim.Run.Status != RunStatusRunning {
		t.Fatalf("claim = %#v", claim)
	}

	if _, err := repo.beginSyncOperation(ctx, tenantID, syncID, manualOperationKey("different"), operationTriggerManual, "", false, false); !errors.Is(err, ErrOperationInProgress) {
		t.Fatalf("concurrent different operation error = %v, want ErrOperationInProgress", err)
	}

	plan := operationAttemptPlan{
		Sequence: 1, Kind: "webhook_batch", IdempotencyKey: claim.Run.ID + ":webhook:1",
		PayloadSHA256: payloadSHA256([]byte("bounded payload")), RowCount: 2,
	}
	if err := repo.planRunAttempts(ctx, tenantID, claim.Run.ID, []operationAttemptPlan{plan}); err != nil {
		t.Fatalf("plan attempt: %v", err)
	}
	if err := repo.markRunAttemptDelivering(ctx, tenantID, claim.Run.ID, 1); err != nil {
		t.Fatalf("mark delivering: %v", err)
	}
	if err := repo.finishRunAttempt(ctx, tenantID, claim.Run.ID, 1, true, ""); err != nil {
		t.Fatalf("acknowledge attempt: %v", err)
	}
	finished, err := repo.finishSyncOperationForTenant(ctx, tenantID, claim, RunStatusSucceeded, syncExecutionResult{
		RowsExported: 2, BatchesSent: 1, SourceMembersObserved: 2, ExternalEffectAttempted: true,
	}, "")
	if err != nil {
		t.Fatalf("finish operation: %v", err)
	}
	if finished.Status != RunStatusSucceeded || finished.RowsExported != 2 || finished.SourceMembersObserved != 2 {
		t.Fatalf("finished = %#v", finished)
	}

	replay, err := repo.beginSyncOperation(ctx, tenantID, syncID, key, operationTriggerManual, "", false, false)
	if err != nil {
		t.Fatalf("replay operation: %v", err)
	}
	if replay.Created || replay.Run.ID != claim.Run.ID || replay.Run.Status != RunStatusSucceeded {
		t.Fatalf("replay = %#v, original run = %s", replay, claim.Run.ID)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("inspect tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runs, attempts int
	var attemptStatus string
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM audience_sync_runs WHERE tenant_id=$1::uuid AND sync_id=$2::uuid`, tenantID, syncID).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*), max(status) FROM audience_sync_run_attempts WHERE tenant_id=$1::uuid AND run_id=$2::uuid`, tenantID, claim.Run.ID).Scan(&attempts, &attemptStatus); err != nil {
		t.Fatalf("inspect attempts: %v", err)
	}
	if runs != 1 || attempts != 1 || attemptStatus != "acknowledged" {
		t.Fatalf("runs=%d attempts=%d status=%q", runs, attempts, attemptStatus)
	}
}

func TestSchedulerClaimsAreDisjointAcrossReplicas(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)
	segmentID := seedOperationSafetySegment(t, pool, tenantID)
	wantIDs := map[string]struct{}{}
	for i := 0; i < 4; i++ {
		wantIDs[seedOperationSafetySync(t, pool, tenantID, segmentID, ScheduleHourly)] = struct{}{}
	}

	type result struct {
		rows []dueSync
		err  error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, owner := range []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"} {
		owner := owner
		go func() {
			<-start
			rows, err := (&SyncScheduler{Pool: pool}).claimDue(ctx, owner, tenantID)
			results <- result{rows: rows, err: err}
		}()
	}
	close(start)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("claim errors = %v / %v", first.err, second.err)
	}
	seen := map[string]struct{}{}
	for _, batch := range [][]dueSync{first.rows, second.rows} {
		for _, row := range batch {
			if _, ours := wantIDs[row.syncID]; !ours {
				continue
			}
			if _, duplicate := seen[row.syncID]; duplicate {
				t.Fatalf("sync %s was claimed by both replicas", row.syncID)
			}
			seen[row.syncID] = struct{}{}
			if row.operationKey == "" {
				t.Fatalf("sync %s missing durable operation key", row.syncID)
			}
		}
	}
	if len(seen) != len(wantIDs) {
		t.Fatalf("claimed %d/%d seeded due syncs; first=%d second=%d", len(seen), len(wantIDs), len(first.rows), len(second.rows))
	}
}

func TestDestinationJobExistsBeforeProviderWorkAndReplays(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)
	segmentID := seedOperationSafetySegment(t, pool, tenantID)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var destinationID string
	if err := tx.QueryRow(ctx, `
INSERT INTO audience_destinations (tenant_id, provider, segment_id, status, config)
VALUES ($1::uuid, 'meta', $2::uuid, 'active', '{"audience_id":"test"}'::jsonb)
RETURNING id::text`, tenantID, segmentID).Scan(&destinationID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed destination: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit destination: %v", err)
	}

	repo := &Repo{Pool: pool}
	key := manualOperationKey("destination-retry")
	claim, err := repo.beginDestinationOperation(ctx, tenantID, destinationID, key)
	if err != nil {
		t.Fatalf("begin destination operation: %v", err)
	}
	if !claim.Created || claim.Job == nil || claim.Job.Status != RunStatusRunning {
		t.Fatalf("claim = %#v", claim)
	}
	var persistedStatus string
	inspect, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("inspect tx: %v", err)
	}
	if err := inspect.QueryRow(ctx, `SELECT status FROM audience_sync_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, claim.Job.ID).Scan(&persistedStatus); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatalf("inspect pre-effect job: %v", err)
	}
	_ = inspect.Rollback(ctx)
	if persistedStatus != RunStatusRunning {
		t.Fatalf("pre-effect job status = %q", persistedStatus)
	}

	replay, err := repo.beginDestinationOperation(ctx, tenantID, destinationID, key)
	if err != nil {
		t.Fatalf("replay destination operation: %v", err)
	}
	if replay.Created || replay.Job.ID != claim.Job.ID {
		t.Fatalf("replay = %#v", replay)
	}
	if _, err := repo.beginDestinationOperation(ctx, tenantID, destinationID, manualOperationKey("other")); !errors.Is(err, ErrOperationInProgress) {
		t.Fatalf("concurrent destination operation error = %v", err)
	}

	job, err := repo.finishDestinationOperation(ctx, tenantID, claim, RunStatusRejected,
		"audience cap exceeded before provider work", 0, SyncMaxRows+1, true, ProviderRunEvidence{})
	if err != nil {
		t.Fatalf("finish rejected destination operation: %v", err)
	}
	if job.Status != RunStatusRejected || !job.CapExceeded || job.SourceMembersObserved != SyncMaxRows+1 || job.MembersSynced != 0 {
		t.Fatalf("rejected job = %#v", job)
	}
}

func TestWebhookRunPersistsAttemptBeforeDeliveryAndDoesNotReplay(t *testing.T) {
	pool := newSyncRunnerTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00a0d1e57e57"
	seedSyncTestTenant(t, pool, tenantID)
	segmentID := seedOperationSafetySegment(t, pool, tenantID)
	syncID := seedOperationSafetySync(t, pool, tenantID, segmentID, ScheduleManual)

	calls := 0
	var batchID, idempotencyKey string
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		batchID = r.Header.Get(SyncBatchIDHeader)
		idempotencyKey = r.Header.Get("Idempotency-Key")
		var persisted string
		inspect, err := db.WithTenant(r.Context(), pool, tenantID)
		if err != nil {
			t.Errorf("receiver inspect tx: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		defer func() { _ = inspect.Rollback(r.Context()) }()
		if err := inspect.QueryRow(r.Context(), `
SELECT status FROM audience_sync_run_attempts
 WHERE tenant_id=$1::uuid AND idempotency_key=$2`, tenantID, batchID).Scan(&persisted); err != nil {
			t.Errorf("receiver could not observe pre-effect attempt: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if persisted != "delivering" {
			t.Errorf("attempt status at receiver = %q, want delivering", persisted)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()

	update, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("update destination tx: %v", err)
	}
	if _, err := update.Exec(ctx, `UPDATE audience_syncs SET destination_url=$3 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, syncID, receiver.URL); err != nil {
		_ = update.Rollback(ctx)
		t.Fatalf("set receiver URL: %v", err)
	}
	if err := update.Commit(ctx); err != nil {
		t.Fatalf("commit receiver URL: %v", err)
	}

	runner := &SyncRunner{
		Repo:           &Repo{Pool: pool},
		HTTPClient:     receiver.Client(),
		verifySourceFn: func(context.Context, string, *Sync) error { return nil },
		resolveMembersFn: func(context.Context, string, *Sync) ([]MemberRow, bool, error) {
			return []MemberRow{{Email: "one@example.test"}, {Email: "two@example.test"}}, false, nil
		},
	}
	run, err := runner.RunIdempotent(ctx, tenantID, syncID, "same-request")
	if err != nil {
		t.Fatalf("run webhook: %v", err)
	}
	if run.Status != RunStatusSucceeded || run.RowsExported != 2 || run.BatchesSent != 1 || run.SourceMembersObserved != 2 {
		t.Fatalf("run = %#v", run)
	}
	if calls != 1 || batchID == "" || idempotencyKey != batchID {
		t.Fatalf("calls=%d batchID=%q idempotency=%q", calls, batchID, idempotencyKey)
	}
	replay, err := runner.RunIdempotent(ctx, tenantID, syncID, "same-request")
	if err != nil {
		t.Fatalf("replay webhook: %v", err)
	}
	if replay.ID != run.ID || calls != 1 {
		t.Fatalf("replay run=%s original=%s calls=%d", replay.ID, run.ID, calls)
	}
}
