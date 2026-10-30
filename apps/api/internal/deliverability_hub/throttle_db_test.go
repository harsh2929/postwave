// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

const throttleTestTenantID = "00000000-0000-4000-8000-184500000001"
const throttleTestUserID = "00000000-0000-4000-8000-184500000002"

var throttleTestLeaseSequence atomic.Int64

var errThrottleTestCommitReplyLost = errors.New("test: postgres commit reply lost")

func commitThrottleTxThenLoseReply(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return errThrottleTestCommitReplyLost
}

func rollbackThrottleTxThenFail(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Rollback(ctx); err != nil {
		return err
	}
	return errThrottleTestCommitReplyLost
}

type throttleTestCapCoordinator struct {
	commitErr       error
	abortCall       *int
	abortPool       *db.Pool
	abortReentryErr *error
}

func (throttleTestCapCoordinator) BeginCapChangeLocked(ctx context.Context, _ pgx.Tx, tenantID string, _, _ *int) (sending.CapChangeLease, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return sending.CapChangeLease{}, errors.New("test cap coordinator: Hub mutation is missing a deadline")
	}
	if remaining := time.Until(deadline); remaining <= 0 ||
		remaining > sending.CapMutationMaxDuration+time.Millisecond {
		return sending.CapChangeLease{}, errors.New("test cap coordinator: Hub mutation deadline is outside bound")
	}
	return sending.CapChangeLease{
		TenantID: tenantID,
		Token:    fmt.Sprintf("test-cap-lease-%d", throttleTestLeaseSequence.Add(1)),
	}, nil
}

func (c throttleTestCapCoordinator) CommitCapChange(context.Context, sending.CapChangeLease, *int) error {
	return c.commitErr
}

func (c throttleTestCapCoordinator) AbortCapChange(ctx context.Context, lease sending.CapChangeLease) error {
	if c.abortCall != nil {
		*c.abortCall++
	}
	if c.abortPool != nil {
		// A real abort resolves the canonical cap in a fresh transaction. Bound
		// this probe tightly so the regression is deterministic: if the caller
		// still owns the only pool connection/advisory lock, it must time out.
		probeCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
		committed, err := sending.CapMutationCommitted(probeCtx, c.abortPool, lease.TenantID, lease.Token)
		cancel()
		if err == nil && committed {
			err = errors.New("test cap coordinator: rolled-back mutation unexpectedly has a receipt")
		}
		if c.abortReentryErr != nil {
			*c.abortReentryErr = err
		}
		return err
	}
	return nil
}

func newThrottleDBTestPool(t *testing.T) *db.Pool {
	return newThrottleDBTestPoolWithMaxConns(t, 0)
}

func newThrottleDBTestPoolWithMaxConns(t *testing.T, maxConns int32) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping throttle DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to throttle test database: %v", err)
	}
	if maxConns > 0 && pool.Config().MaxConns != maxConns {
		cfg := pool.Config()
		pool.Close()
		cfg.MaxConns = maxConns
		cfg.MinConns = 0
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatalf("connect to throttle test database with max_conns=%d: %v", maxConns, err)
		}
		if err := pool.Ping(ctx); err != nil {
			pool.Close()
			t.Fatalf("ping throttle test database with max_conns=%d: %v", maxConns, err)
		}
	}
	t.Cleanup(pool.Close)

	var migrated bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.deliverability_throttle_state') IS NOT NULL
   AND to_regclass('public.deliverability_repair_overrides_one_active_per_tenant_uidx') IS NOT NULL
   AND to_regclass('public.tenant_sending_cap_mutation_receipts') IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'deliverability_remediations'
          AND column_name = 'release_kind'
   )`).Scan(&migrated); err != nil {
		t.Fatalf("inspect throttle migration: %v", err)
	}
	if !migrated {
		t.Fatalf("deliverability throttle migrations through 2036 are not applied to the test database")
	}
	return pool
}

func seedThrottleDBFixture(t *testing.T, pool *db.Pool, lowSince, lastSampled time.Time) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin throttle fixture transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`,
		throttleTestTenantID,
	); err != nil {
		t.Fatalf("bind throttle fixture tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, throttleTestTenantID); err != nil {
		t.Fatalf("clean prior throttle fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'deliverability-throttle-test', 'deliverability-throttle-test', 'studio')`,
		throttleTestTenantID); err != nil {
		t.Fatalf("seed throttle tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, 'deliverability-throttle-test-user',
        'deliverability-throttle-test@example.invalid', 'owner')`,
		throttleTestUserID, throttleTestTenantID); err != nil {
		t.Fatalf("seed throttle user: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_settings
    (tenant_id, max_sends_per_hour, updated_by_user_id, updated_at)
VALUES ($1::uuid, 8000, $3::uuid, $2)`,
		throttleTestTenantID, lastSampled, throttleTestUserID); err != nil {
		t.Fatalf("seed throttle sending settings: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO deliverability_throttle_state
    (tenant_id, low_since, last_sampled_at, last_score, sample_qualified, updated_at)
VALUES ($1::uuid, $2, $3, 40, true, $3)`,
		throttleTestTenantID, lowSince, lastSampled); err != nil {
		t.Fatalf("seed throttle observation state: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit throttle fixture: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithWorkerScope(cleanupCtx, pool)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx,
			`SELECT set_config('app.tenant_id', $1, true)`,
			throttleTestTenantID,
		)
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, throttleTestTenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
}

func TestHealthyTenantWithoutOverrideDoesNotAccumulateReleaseWindow_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	base := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, base.Add(-24*time.Hour), base.Add(-time.Hour))
	worker := &Worker{Deps: &Deps{
		Pool:           pool,
		HubInterval:    time.Hour,
		Clock:          func() time.Time { return base },
		CapCoordinator: throttleTestCapCoordinator{},
	}}

	for i := 0; i < 8; i++ {
		at := base.Add(time.Duration(i) * time.Hour)
		snapshotID := seedSnapshot(t, pool, ctx, 95, at)
		result, err := worker.observeAndMaybeAutoThrottle(
			ctx, throttleTestTenantID, 95, true, snapshotID, at,
		)
		if err != nil || result.Applied || result.Released {
			t.Fatalf("healthy observation %d result=%+v err=%v", i, result, err)
		}
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin healthy-state verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var highSince *time.Time
	var activeOverrides int
	if err := verify.QueryRow(ctx, `
SELECT (SELECT high_since FROM deliverability_throttle_state WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND cleared_at IS NULL)`, throttleTestTenantID).Scan(
		&highSince, &activeOverrides,
	); err != nil {
		t.Fatalf("read healthy throttle state: %v", err)
	}
	if highSince != nil || activeOverrides != 0 {
		t.Fatalf("healthy tenant high_since=%v active=%d, want nil/0", highSince, activeOverrides)
	}
}

func TestAutomaticReleaseRaceToNoActiveOverrideIsCleanNoop_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	releaseAt := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, releaseAt.Add(-24*time.Hour), releaseAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, ctx, 95, releaseAt)
	state, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin recovery-race state: %v", err)
	}
	if _, err := state.Exec(ctx, `
UPDATE deliverability_throttle_state
   SET low_since=NULL, high_since=$2, last_sampled_at=$3,
       last_score=95, sample_qualified=true, updated_at=$3
 WHERE tenant_id=$1::uuid`, throttleTestTenantID,
		releaseAt.Add(-AutoThrottleRecoveryWindow), releaseAt); err != nil {
		_ = state.Rollback(ctx)
		t.Fatalf("seed recovery-race state: %v", err)
	}
	if err := state.Commit(ctx); err != nil {
		t.Fatalf("commit recovery-race state: %v", err)
	}

	var logs bytes.Buffer
	worker := &Worker{Deps: &Deps{
		Pool:   pool,
		Clock:  func() time.Time { return releaseAt },
		Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
	}}
	result := worker.releaseIfRecovered(
		ctx,
		throttleTestTenantID,
		true,
		throttleReleaseEvidence{SnapshotID: snapshotID, Score: 95},
	)
	if result.Cleared || result.CapConvergencePending {
		t.Fatalf("race-to-no-active result=%+v, want clean no-op", result)
	}
	if strings.Contains(logs.String(), "auto-release failed") {
		t.Fatalf("race-to-no-active emitted false failure log: %s", logs.String())
	}
}

func TestAutoThrottleConcurrentWorkersHaveOneWinnerAndExactClear_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	observedAt := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, context.Background(), 40, observedAt)

	// The worker's observation timestamp is captured before it waits for either
	// tenant lock. Seed a durable revision ahead of both that timestamp and the
	// database clock so the apply path must advance from the canonical row,
	// never write its older observation time back into updated_at.
	futureApplyRevision := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Microsecond)
	revisionSeed, err := db.WithTenant(context.Background(), pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin apply revision seed: %v", err)
	}
	if _, err := revisionSeed.Exec(context.Background(), `
UPDATE tenant_sending_settings
   SET updated_at = $2
 WHERE tenant_id = $1::uuid`, throttleTestTenantID, futureApplyRevision); err != nil {
		_ = revisionSeed.Rollback(context.Background())
		t.Fatalf("seed future apply revision: %v", err)
	}
	if err := revisionSeed.Commit(context.Background()); err != nil {
		t.Fatalf("commit apply revision seed: %v", err)
	}

	workers := []*Worker{
		{Deps: &Deps{Pool: pool, HubInterval: time.Hour, Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}},
		{Deps: &Deps{Pool: pool, HubInterval: time.Hour, Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}},
	}
	type workerResult struct {
		result throttleApplyResult
		err    error
	}
	start := make(chan struct{})
	results := make(chan workerResult, len(workers))
	var wg sync.WaitGroup
	for _, worker := range workers {
		wg.Add(1)
		go func(w *Worker) {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			result, err := w.observeAndMaybeAutoThrottle(
				ctx, throttleTestTenantID, 40, true, snapshotID, observedAt,
			)
			results <- workerResult{result: result, err: err}
		}(worker)
	}
	close(start)
	wg.Wait()
	close(results)

	winners := 0
	var applied throttleApplyResult
	for got := range results {
		if got.err != nil {
			t.Fatalf("concurrent throttle worker: %v", got.err)
		}
		if got.result.Applied {
			winners++
			applied = got.result
		}
	}
	if winners != 1 {
		t.Fatalf("applied winners=%d, want exactly 1", winners)
	}
	if applied.OverrideID == 0 || applied.PriorCap != 8000 || applied.NextCap != 4000 {
		t.Fatalf("winner result=%+v, want prior=8000 next=4000 with override id", applied)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin throttle verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var (
		activeCount   int
		capValue      int
		applyRevision time.Time
		applyUpdater  *string
		applyAudits   int
	)
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM deliverability_repair_overrides
 WHERE tenant_id = $1::uuid AND cleared_at IS NULL`, throttleTestTenantID).Scan(&activeCount); err != nil {
		t.Fatalf("count active overrides: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT max_sends_per_hour, updated_at, updated_by_user_id::text
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid`, throttleTestTenantID).Scan(
		&capValue, &applyRevision, &applyUpdater,
	); err != nil {
		t.Fatalf("read throttled cap: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action = 'deliverability.throttle.applied'
   AND actor_type = 'system'
   AND user_id IS NULL`, throttleTestTenantID).Scan(&applyAudits); err != nil {
		t.Fatalf("read apply audit: %v", err)
	}
	if activeCount != 1 || capValue != 4000 {
		t.Fatalf("active=%d cap=%d, want active=1 cap=4000", activeCount, capValue)
	}
	if applyUpdater != nil || applyAudits != 1 {
		t.Fatalf("auto apply attribution updater=%v audits=%d, want nil/system audit", applyUpdater, applyAudits)
	}
	if !applyRevision.After(futureApplyRevision) {
		t.Fatalf("apply revision=%s, want after prior canonical revision %s",
			applyRevision, futureApplyRevision)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit throttle verification: %v", err)
	}

	// The partial unique index is the final guard even for a writer that does
	// not participate in the advisory-lock protocol.
	duplicate, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin duplicate override check: %v", err)
	}
	_, duplicateErr := duplicate.Exec(ctx, `
INSERT INTO deliverability_repair_overrides
    (tenant_id, prior_max_sends_per_hour, throttled_max_sends_per_hour, reason)
VALUES ($1::uuid, 4000, 2000, 'test duplicate')`, throttleTestTenantID)
	_ = duplicate.Rollback(ctx)
	if duplicateErr == nil {
		t.Fatal("database accepted a second active override")
	}

	// Add immutable history so the clear assertion proves it updates the exact
	// selected active ID, not every row belonging to the tenant.
	history, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin history seed: %v", err)
	}
	var historyID int64
	if err := history.QueryRow(ctx, `
INSERT INTO deliverability_repair_overrides
    (tenant_id, prior_max_sends_per_hour, throttled_max_sends_per_hour,
     reason, created_at, cleared_at, cleared_by)
VALUES ($1::uuid, 16000, 8000, 'historical', $2, $3, 'historical-operator')
RETURNING id`,
		throttleTestTenantID,
		observedAt.Add(-72*time.Hour),
		observedAt.Add(-48*time.Hour),
	).Scan(&historyID); err != nil {
		_ = history.Rollback(ctx)
		t.Fatalf("seed historical override: %v", err)
	}
	if err := history.Commit(ctx); err != nil {
		t.Fatalf("commit historical override: %v", err)
	}

	deps := &Deps{Pool: pool, Clock: func() time.Time { return observedAt.Add(time.Minute) }, CapCoordinator: throttleTestCapCoordinator{}}
	// A legitimate plan/admin edit while the override is active is a newer
	// decision. Clear must return a typed conflict without erasing the override
	// or restoring the stale pre-throttle cap.
	drift, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin cap drift fixture: %v", err)
	}
	if _, err := drift.Exec(ctx, `
UPDATE tenant_sending_settings
   SET max_sends_per_hour = 3500, updated_at = $2
 WHERE tenant_id = $1::uuid`, throttleTestTenantID, observedAt); err != nil {
		_ = drift.Rollback(ctx)
		t.Fatalf("seed cap drift: %v", err)
	}
	if err := drift.Commit(ctx); err != nil {
		t.Fatalf("commit cap drift: %v", err)
	}
	if _, err := deps.clearOverride(
		ctx, throttleTestTenantID, "operator-conflict", automaticThrottleAuditMeta(throttleTestTenantID),
	); !errors.Is(err, ErrThrottleCapDrift) {
		t.Fatalf("clear drift error=%v, want ErrThrottleCapDrift", err)
	}
	driftCheck, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin cap drift verification: %v", err)
	}
	var driftedCap, stillActive int
	if err := driftCheck.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND cleared_at IS NULL)`, throttleTestTenantID).Scan(
		&driftedCap, &stillActive,
	); err != nil {
		_ = driftCheck.Rollback(ctx)
		t.Fatalf("verify cap drift conflict: %v", err)
	}
	if err := driftCheck.Commit(ctx); err != nil {
		t.Fatalf("commit cap drift verification: %v", err)
	}
	if driftedCap != 3500 || stillActive != 1 {
		t.Fatalf("drift conflict cap=%d active=%d, want cap=3500 active=1", driftedCap, stillActive)
	}
	restoreInstalled, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin installed-cap restore: %v", err)
	}
	futureClearRevision := futureApplyRevision.Add(time.Hour)
	if _, err := restoreInstalled.Exec(ctx, `
UPDATE tenant_sending_settings
   SET max_sends_per_hour = 4000, updated_at = $2
 WHERE tenant_id = $1::uuid`, throttleTestTenantID, futureClearRevision); err != nil {
		_ = restoreInstalled.Rollback(ctx)
		t.Fatalf("restore override-installed cap: %v", err)
	}
	if err := restoreInstalled.Commit(ctx); err != nil {
		t.Fatalf("commit installed-cap restore: %v", err)
	}
	clearResult, err := deps.clearOverride(
		ctx, throttleTestTenantID, "operator-1", automaticThrottleAuditMeta(throttleTestTenantID),
	)
	if err != nil {
		t.Fatalf("clear active override: %v", err)
	}
	if !clearResult.Cleared || clearResult.CapConvergencePending {
		t.Fatalf("clear result = %+v", clearResult)
	}

	check, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin clear verification: %v", err)
	}
	defer func() { _ = check.Rollback(ctx) }()
	var (
		activeClearedBy  string
		historyClearedBy string
		restoredCap      int
		restoredRevision time.Time
		restoredUpdater  *string
		lowSince         *time.Time
		clearAudits      int
	)
	if err := check.QueryRow(ctx, `
SELECT cleared_by
  FROM deliverability_repair_overrides
 WHERE id = $1`, applied.OverrideID).Scan(&activeClearedBy); err != nil {
		t.Fatalf("read cleared active override: %v", err)
	}
	if err := check.QueryRow(ctx, `
SELECT cleared_by
  FROM deliverability_repair_overrides
 WHERE id = $1`, historyID).Scan(&historyClearedBy); err != nil {
		t.Fatalf("read historical override: %v", err)
	}
	if err := check.QueryRow(ctx, `
SELECT max_sends_per_hour, updated_at, updated_by_user_id::text
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid`, throttleTestTenantID).Scan(
		&restoredCap, &restoredRevision, &restoredUpdater,
	); err != nil {
		t.Fatalf("read restored cap: %v", err)
	}
	if err := check.QueryRow(ctx, `
SELECT low_since
  FROM deliverability_throttle_state
 WHERE tenant_id = $1::uuid`, throttleTestTenantID).Scan(&lowSince); err != nil {
		t.Fatalf("read reset low-score state: %v", err)
	}
	if err := check.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action = 'deliverability.throttle.cleared'
   AND actor_type = 'system'
   AND user_id IS NULL`, throttleTestTenantID).Scan(&clearAudits); err != nil {
		t.Fatalf("read clear audit: %v", err)
	}
	if activeClearedBy != "operator-1" || historyClearedBy != "historical-operator" {
		t.Fatalf("clear attribution active=%q history=%q", activeClearedBy, historyClearedBy)
	}
	if restoredCap != 8000 || lowSince != nil || restoredUpdater != nil || clearAudits != 1 {
		t.Fatalf("restored cap=%d low_since=%v updater=%v audits=%d, want 8000/nil/nil/1",
			restoredCap, lowSince, restoredUpdater, clearAudits)
	}
	if !restoredRevision.After(futureClearRevision) {
		t.Fatalf("clear revision=%s, want after prior canonical revision %s",
			restoredRevision, futureClearRevision)
	}
	if err := check.Commit(ctx); err != nil {
		t.Fatalf("commit clear verification: %v", err)
	}

	if _, err := deps.clearOverride(
		ctx, throttleTestTenantID, "operator-2", automaticThrottleAuditMeta(throttleTestTenantID),
	); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("second clear error=%v, want pgx.ErrNoRows", err)
	}
}

func TestAutoThrottleReturnsCommittedPendingResultWhenRedisCommitFails_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	observedAt := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, context.Background(), 40, observedAt)

	worker := &Worker{Deps: &Deps{
		Pool: pool, HubInterval: time.Hour,
		Clock:          func() time.Time { return observedAt },
		CapCoordinator: throttleTestCapCoordinator{commitErr: sending.ErrCapCoordinationUnavailable},
	}}
	result, err := worker.observeAndMaybeAutoThrottle(
		context.Background(), throttleTestTenantID, 40, true, snapshotID, observedAt,
	)
	if err != nil {
		t.Fatalf("committed apply returned an error: %v", err)
	}
	if !result.Applied || !result.CapConvergencePending || result.OverrideID == 0 || result.NextCap != 4000 {
		t.Fatalf("committed-pending apply result = %+v", result)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin apply-pending verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var capValue, active int
	if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND cleared_at IS NULL)`, throttleTestTenantID).Scan(&capValue, &active); err != nil {
		t.Fatalf("verify committed apply: %v", err)
	}
	if capValue != 4000 || active != 1 {
		t.Fatalf("committed apply cap=%d active=%d, want 4000/1", capValue, active)
	}
}

func TestAdminClearReportsCommittedPendingAndKeepsDurableClear_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	observedAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, context.Background(), 40, observedAt)
	deps := &Deps{
		Pool: pool, HubInterval: time.Hour,
		Clock:          func() time.Time { return observedAt },
		CapCoordinator: throttleTestCapCoordinator{},
	}
	result, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		context.Background(), throttleTestTenantID, 40, true, snapshotID, observedAt,
	)
	if err != nil || !result.Applied {
		t.Fatalf("seed active override result=%+v err=%v", result, err)
	}

	deps.CapCoordinator = throttleTestCapCoordinator{commitErr: sending.ErrCapCoordinationUnavailable}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/repair/override", nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: throttleTestTenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: throttleTestUserID, TenantID: throttleTestTenantID})
	recorder := httptest.NewRecorder()
	deps.postRepairOverride(recorder, req.WithContext(ctx))
	if recorder.Code != http.StatusServiceUnavailable ||
		recorder.Header().Get("X-Postwave-Sending-Cap-Outcome") != "committed-conservatively-fenced" ||
		!strings.Contains(recorder.Body.String(), `"error":{"code":"sending_cap_convergence_pending"`) ||
		!strings.Contains(recorder.Body.String(), `"cleared":true`) ||
		!strings.Contains(recorder.Body.String(), `"cap_coordination_outcome":"committed-conservatively-fenced"`) {
		t.Fatalf("admin pending response = %d headers=%v body=%s",
			recorder.Code, recorder.Header(), recorder.Body.String())
	}

	verifyCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	verify, err := db.WithTenant(verifyCtx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin clear-pending verification: %v", err)
	}
	defer func() { _ = verify.Rollback(verifyCtx) }()
	var capValue, active, adminClearAudits int
	var updatedBy *string
	if err := verify.QueryRow(verifyCtx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND cleared_at IS NULL),
       (SELECT updated_by_user_id::text FROM tenant_sending_settings WHERE tenant_id=$1::uuid)`,
		throttleTestTenantID).Scan(&capValue, &active, &updatedBy); err != nil {
		t.Fatalf("verify committed clear: %v", err)
	}
	if err := verify.QueryRow(verifyCtx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id=$1::uuid
   AND action='deliverability.throttle.cleared'
   AND actor_type='human'
   AND user_id=$2::uuid`, throttleTestTenantID, throttleTestUserID).Scan(&adminClearAudits); err != nil {
		t.Fatalf("verify admin clear audit: %v", err)
	}
	if capValue != 8000 || active != 0 || updatedBy == nil || *updatedBy != throttleTestUserID || adminClearAudits != 1 {
		t.Fatalf("committed clear cap=%d active=%d updater=%v audits=%d, want 8000/0/%s/1",
			capValue, active, updatedBy, adminClearAudits, throttleTestUserID)
	}
}

func TestLegacyDurableCapsDoNotMakeReceiptEvidenceRollBackApplyOrClear_DB(t *testing.T) {
	for _, legacyCap := range []int{0, -10, 1_500_000} {
		t.Run(fmt.Sprintf("cap_%d", legacyCap), func(t *testing.T) {
			pool := newThrottleDBTestPool(t)
			observedAt := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
			seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			seedLegacy, err := db.WithTenant(ctx, pool, throttleTestTenantID)
			if err != nil {
				t.Fatalf("begin legacy cap seed: %v", err)
			}
			if _, err := seedLegacy.Exec(ctx, `
UPDATE tenant_sending_settings
   SET max_sends_per_hour=$2
 WHERE tenant_id=$1::uuid`, throttleTestTenantID, legacyCap); err != nil {
				_ = seedLegacy.Rollback(ctx)
				t.Fatalf("seed legacy cap: %v", err)
			}
			if err := seedLegacy.Commit(ctx); err != nil {
				t.Fatalf("commit legacy cap: %v", err)
			}

			deps := &Deps{Pool: pool, HubInterval: time.Hour,
				Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
			snapshotID := seedSnapshot(t, pool, ctx, 40, observedAt)
			applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
				ctx, throttleTestTenantID, 40, true, snapshotID, observedAt,
			)
			if err != nil || !applied.Applied {
				t.Fatalf("legacy apply result=%+v err=%v", applied, err)
			}
			cleared, err := deps.clearOverride(
				ctx, throttleTestTenantID, "legacy-cap-operator", automaticThrottleAuditMeta(throttleTestTenantID),
			)
			if err != nil || !cleared.Cleared {
				t.Fatalf("legacy clear result=%+v err=%v", cleared, err)
			}

			verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
			if err != nil {
				t.Fatalf("begin legacy verification: %v", err)
			}
			defer func() { _ = verify.Rollback(ctx) }()
			var restored, receiptCount int
			if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM tenant_sending_cap_mutation_receipts WHERE tenant_id=$1::uuid)`,
				throttleTestTenantID).Scan(&restored, &receiptCount); err != nil {
				t.Fatalf("verify legacy cap: %v", err)
			}
			if restored != legacyCap || receiptCount != 2 {
				t.Fatalf("legacy restored=%d receipts=%d, want %d/2", restored, receiptCount, legacyCap)
			}
		})
	}
}

func TestAutoThrottleClassifiesAmbiguousPostgresCommitFromExactReceipt_DB(t *testing.T) {
	for _, test := range []struct {
		name          string
		commit        func(context.Context, pgx.Tx) error
		receipt       func(context.Context, string, string) (bool, error)
		wantApplied   bool
		wantUnknown   bool
		wantAnyError  bool
		wantAbortCall int
	}{
		{
			name:        "server committed before reply loss",
			commit:      commitThrottleTxThenLoseReply,
			wantApplied: true,
		},
		{
			name:          "server rolled back before error",
			commit:        rollbackThrottleTxThenFail,
			wantAnyError:  true,
			wantAbortCall: 1,
		},
		{
			name:   "server committed but receipt is unreadable",
			commit: commitThrottleTxThenLoseReply,
			receipt: func(context.Context, string, string) (bool, error) {
				return false, errors.New("test: receipt authority unavailable")
			},
			wantAnyError: true,
			wantUnknown:  true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := newThrottleDBTestPool(t)
			observedAt := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
			seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
			snapshotID := seedSnapshot(t, pool, context.Background(), 40, observedAt)
			abortCalls := 0
			deps := &Deps{
				Pool: pool, HubInterval: time.Hour,
				Clock:               func() time.Time { return observedAt },
				CapCoordinator:      throttleTestCapCoordinator{abortCall: &abortCalls},
				commitCapMutationTx: test.commit,
				capMutationReceipt:  test.receipt,
			}
			result, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
				context.Background(), throttleTestTenantID, 40, true, snapshotID, observedAt,
			)
			if (err != nil) != test.wantAnyError {
				t.Fatalf("apply error = %v, wantAnyError=%v", err, test.wantAnyError)
			}
			if errors.Is(err, ErrThrottleCommitOutcomeUnknown) != test.wantUnknown {
				t.Fatalf("apply error = %v, wantUnknown=%v", err, test.wantUnknown)
			}
			if result.Applied != test.wantApplied || abortCalls != test.wantAbortCall {
				t.Fatalf("apply result=%+v abortCalls=%d, want applied=%v abortCalls=%d",
					result, abortCalls, test.wantApplied, test.wantAbortCall)
			}
		})
	}
}

func TestAdminClearClassifiesAmbiguousPostgresCommitAndUsesNestedEnvelope_DB(t *testing.T) {
	for _, test := range []struct {
		name          string
		commit        func(context.Context, pgx.Tx) error
		receipt       func(context.Context, string, string) (bool, error)
		wantStatus    int
		wantOutcome   string
		wantErrorCode string
		wantOK        string
		wantCleared   string
		wantAbortCall int
	}{
		{
			name:        "server committed before reply loss",
			commit:      commitThrottleTxThenLoseReply,
			wantStatus:  http.StatusOK,
			wantOutcome: "committed",
			wantOK:      `"ok":true`,
			wantCleared: `"cleared":true`,
		},
		{
			name:          "server rolled back before error",
			commit:        rollbackThrottleTxThenFail,
			wantStatus:    http.StatusInternalServerError,
			wantOutcome:   "not-committed",
			wantAbortCall: 1,
		},
		{
			name:   "server committed but receipt is unreadable",
			commit: commitThrottleTxThenLoseReply,
			receipt: func(context.Context, string, string) (bool, error) {
				return false, errors.New("test: receipt authority unavailable")
			},
			wantStatus:    http.StatusServiceUnavailable,
			wantOutcome:   "commit-outcome-unknown-conservatively-fenced",
			wantErrorCode: "sending_cap_commit_outcome_unknown",
			wantOK:        `"ok":false`,
			wantCleared:   `"cleared":false`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := newThrottleDBTestPool(t)
			observedAt := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
			seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
			snapshotID := seedSnapshot(t, pool, context.Background(), 40, observedAt)
			abortCalls := 0
			deps := &Deps{
				Pool: pool, HubInterval: time.Hour,
				Clock:          func() time.Time { return observedAt },
				CapCoordinator: throttleTestCapCoordinator{abortCall: &abortCalls},
			}
			seed, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
				context.Background(), throttleTestTenantID, 40, true, snapshotID, observedAt,
			)
			if err != nil || !seed.Applied {
				t.Fatalf("seed active override result=%+v err=%v", seed, err)
			}
			abortCalls = 0
			deps.commitCapMutationTx = test.commit
			deps.capMutationReceipt = test.receipt

			req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/repair/override", nil)
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: throttleTestTenantID})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: throttleTestUserID, TenantID: throttleTestTenantID})
			recorder := httptest.NewRecorder()
			deps.postRepairOverride(recorder, req.WithContext(ctx))

			if recorder.Code != test.wantStatus ||
				recorder.Header().Get("X-Postwave-Sending-Cap-Outcome") != test.wantOutcome ||
				abortCalls != test.wantAbortCall {
				t.Fatalf("admin ambiguity response status=%d outcome=%q abortCalls=%d body=%s",
					recorder.Code,
					recorder.Header().Get("X-Postwave-Sending-Cap-Outcome"),
					abortCalls,
					recorder.Body.String(),
				)
			}
			if test.wantErrorCode != "" &&
				!strings.Contains(recorder.Body.String(), `"error":{"code":"`+test.wantErrorCode+`"`) {
				t.Fatalf("admin ambiguity body lacks nested error %q: %s", test.wantErrorCode, recorder.Body.String())
			}
			for _, fragment := range []string{test.wantOK, test.wantCleared} {
				if fragment != "" && !strings.Contains(recorder.Body.String(), fragment) {
					t.Fatalf("admin ambiguity body lacks %s: %s", fragment, recorder.Body.String())
				}
			}
		})
	}
}
