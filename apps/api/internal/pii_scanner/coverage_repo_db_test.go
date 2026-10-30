// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func requireCoverageMigration(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var tableName *string
	if err := pool.QueryRow(context.Background(), `
SELECT to_regclass('public.subscriber_pii_scan_intents')::text`).Scan(&tableName); err != nil {
		t.Fatalf("inspect coverage migration: %v", err)
	}
	if tableName == nil {
		t.Fatalf("migration 1762 is not applied")
	}
}

func mustTenantScan(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	query string,
	args []any,
	dest ...any,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, query, args...).Scan(dest...); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func mustTenantExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, query string, args ...any) int64 {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return tag.RowsAffected()
}

func mustWorkerScan(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	query string,
	args []any,
	dest ...any,
) {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, query, args...).Scan(dest...); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func mustWorkerExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return tag.RowsAffected()
}

func newCoverageAdminPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	adminConfig, err := pgxpool.ParseConfig(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	appConfig, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	adminConfig.ConnConfig.Database = appConfig.ConnConfig.Database
	admin, err := pgxpool.NewWithConfig(ctx, adminConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	return admin
}

func insertCoverageSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, value string) string {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id string
	err = tx.QueryRow(context.Background(), `
INSERT INTO subscribers (tenant_id, email, status, consent_source, custom_fields)
VALUES ($1::uuid, $2, 'unconfirmed', 'unknown', jsonb_build_object('private_notes', $3::text))
RETURNING id::text`, tenantID, fmt.Sprintf("coverage-%s@example.test", uuid.NewString()), value).Scan(&id)
	if err != nil {
		t.Fatalf("insert coverage subscriber: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit coverage subscriber: %v", err)
	}
	return id
}

func activateCoverageTestContract(t *testing.T, ctx context.Context, repo *Repo) (*Detector, string) {
	t.Helper()
	detector := newTestDetector(t)
	contract, ok := currentCoverageScanContract(detector)
	if !ok {
		t.Fatal("test detector did not produce a coverage contract")
	}
	// Reset the deployment singleton first.
	//
	// `pii_scan_runtime_contract` is one row for the whole deployment, and these
	// tests own it: several deliberately drive it to `unavailable`, and the
	// activation guard legitimately refuses to roll back to a contract already
	// in history. Without a defined starting point the FIRST test in a run
	// passes and every one after it fails at activation — which is what happened
	// once the file stopped skipping.
	//
	// This resets shared fixture state; it does not weaken the assertion. The
	// activation below still has to succeed on its own terms.
	resetTx, resetErr := db.WithWorkerScope(ctx, repo.Pool)
	if resetErr != nil {
		t.Fatalf("reset runtime contract: %v", resetErr)
	}
	if _, err := resetTx.Exec(ctx, `
UPDATE pii_scan_runtime_contract
   SET scan_contract = NULL, scan_contract_history = '{}',
       availability_status = 'unavailable', last_available_at = NULL,
       updated_at = now()
 WHERE singleton`); err != nil {
		_ = resetTx.Rollback(ctx)
		t.Fatalf("reset runtime contract: %v", err)
	}
	if err := resetTx.Commit(ctx); err != nil {
		t.Fatalf("commit runtime contract reset: %v", err)
	}

	accepted, err := repo.activateScannerContract(ctx, true, contract)
	if err != nil || !accepted {
		t.Fatalf("activate test coverage contract accepted=%t err=%v", accepted, err)
	}
	return detector, contract
}

func TestCoveragePipeline_AllWriterBackfillCoalescingCrashDLQAndErasure(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	detector, scanContract := activateCoverageTestContract(t, ctx, repo)

	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatalf("enable scanner: %v", err)
	}
	clusterConfig, err := repo.GetScanConfig(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	clusterConfig = decorateScanConfig(clusterConfig, nil)
	if !clusterConfig.ScanEnabled || !clusterConfig.Available ||
		clusterConfig.RuntimeAvailability != "available" ||
		clusterConfig.RuntimeScanContract != scanContract ||
		clusterConfig.FingerprintKeyVersion != detector.FingerprintKeyVersion() {
		t.Fatalf("keyless serving replica did not report cluster truth: %+v", clusterConfig)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "hidden 123-45-6789")

	// Arbitrary direct SQL (not a subscribers.Repo method) advances revisions
	// and coalesces its intent transactionally.
	for i := 0; i < 2; i++ {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
UPDATE subscribers SET display_name=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID, fmt.Sprintf("revision-%d", i)); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("direct writer update: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var rowRevision, targetRevision, observedRevision, coalesced int64
	if err := tx.QueryRow(ctx, `
SELECT subscriber.pii_scan_revision, intent.target_revision,
       state.observed_revision, state.coalesced_revisions
  FROM subscribers subscriber
  JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=subscriber.tenant_id AND intent.subscriber_id=subscriber.id
  JOIN subscriber_pii_scan_states state
    ON state.tenant_id=subscriber.tenant_id AND state.subscriber_id=subscriber.id
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`, tenantID, subscriberID).
		Scan(&rowRevision, &targetRevision, &observedRevision, &coalesced); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if rowRevision != 3 || targetRevision != rowRevision || observedRevision != rowRevision || coalesced < 1 {
		t.Fatalf("revision evidence row=%d target=%d observed=%d coalesced=%d", rowRevision, targetRevision, observedRevision, coalesced)
	}

	worker := NewCoverageWorker(repo, detector)
	worker.PollInterval = 5 * time.Millisecond
	worker.LeaseTTL = 2 * time.Second
	worker.HandlerTimeout = time.Second
	worker.ReconciliationTimeout = time.Second
	worker.ClaimBatch = 100
	worker.ReconcileBatch = 20
	worker.ReconcileTenants = 20
	var page *FindingPage
	var cfg *ScanConfig
	for tick := 0; tick < 30; tick++ {
		if _, err := worker.Tick(ctx); err != nil {
			t.Fatalf("coverage tick %d: %v", tick, err)
		}
		page, err = repo.ListFindingsForSubscriber(ctx, tenantID, subscriberID, FindingFilter{})
		if err != nil {
			t.Fatal(err)
		}
		cfg, err = repo.GetScanConfig(ctx, tenantID)
		if err != nil || cfg.CoverageEvidence == nil {
			t.Fatalf("coverage config=%+v err=%v", cfg, err)
		}
		if page.Total > 0 && page.Items[0].DetectedType == TypeSSN &&
			cfg.CoverageEvidence.SnapshotExact &&
			cfg.CoverageEvidence.CoveredSubscribers == cfg.CoverageEvidence.TotalSubscribers {
			break
		}
	}
	if page.Total == 0 || page.Items[0].DetectedType != TypeSSN {
		t.Fatalf("direct SQL value was not detected: %+v", page)
	}
	if !cfg.CoverageEvidence.SnapshotExact || cfg.CoverageEvidence.CoveredSubscribers != cfg.CoverageEvidence.TotalSubscribers {
		t.Fatalf("coverage did not catch up exactly: %+v", cfg.CoverageEvidence)
	}

	// Disabled-period rows have state evidence but no intent. Re-enabling bumps
	// the generation and bounded reconciliation seeds their backlog.
	disabled := false
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	backlogID := insertCoverageSubscriber(t, pool, tenantID, "backlog passport A12345678")
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var backlogIntents int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscriber_pii_scan_intents WHERE subscriber_id=$1::uuid`, backlogID).Scan(&backlogIntents); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if backlogIntents != 0 {
		t.Fatalf("disabled write queued %d intents", backlogIntents)
	}
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := worker.Tick(ctx); err != nil {
			t.Fatalf("backfill tick %d: %v", i, err)
		}
	}
	backlogPage, err := repo.ListFindingsForSubscriber(ctx, tenantID, backlogID, FindingFilter{})
	if err != nil || backlogPage.Total == 0 {
		t.Fatalf("enable backfill missed subscriber: page=%+v err=%v", backlogPage, err)
	}

	// Expired claims are reclaimed by another UUID owner. Repeated closed-code
	// failures hit the retry cap, then the bounded operator path requeues them.
	retryID := insertCoverageSubscriber(t, pool, tenantID, "retry poison")
	ownerOne := uuid.NewString()
	claimed, err := repo.ClaimScanIntents(ctx, ownerOne, time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	var retryIntent ScanIntent
	for _, intent := range claimed {
		if intent.SubscriberID == retryID {
			retryIntent = intent
		}
	}
	if retryIntent.SubscriberID == "" {
		t.Fatalf("retry intent not claimed: %+v", claimed)
	}
	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents SET lease_expires_at=now()-interval '1 second'
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, retryID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	ownerTwo := uuid.NewString()
	claimed, err = repo.ClaimScanIntents(ctx, ownerTwo, time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	for _, intent := range claimed {
		if intent.SubscriberID == retryID {
			retryIntent = intent
		}
	}
	if retryIntent.LeaseOwner != ownerTwo {
		t.Fatalf("expired lease owner=%s want %s", retryIntent.LeaseOwner, ownerTwo)
	}
	dead := false
	for !dead {
		dead, err = repo.FailScanIntent(ctx, retryIntent, "detector_failure", time.Now().Add(-time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if dead {
			break
		}
		claimed, err = repo.ClaimScanIntents(ctx, ownerTwo, time.Minute, 100, scanContract)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, intent := range claimed {
			if intent.SubscriberID == retryID {
				retryIntent, found = intent, true
			}
		}
		if !found {
			t.Fatal("retry intent was not reclaimable")
		}
	}
	if affected, err := repo.RequeueDeadLetters(ctx, tenantID, retryID, 1); err != nil || affected != 1 {
		t.Fatalf("operator requeue=(%d,%v), want (1,nil)", affected, err)
	}

	// Erasure cascades queue and coverage state; no PII evidence survives as an
	// orphan. This also proves the composite tenant FK.
	eraseID := insertCoverageSubscriber(t, pool, tenantID, "erase 321-65-4321")
	var deleteDirtyBefore int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &deleteDirtyBefore)
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, eraseID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	workerTx, err = db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	var orphanCount int
	var deleteDirtyAfter int64
	var deleteExact bool
	if err := workerTx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscriber_pii_scan_states WHERE subscriber_id=$1::uuid)
     + (SELECT count(*) FROM subscriber_pii_scan_intents WHERE subscriber_id=$1::uuid),
       coverage.dirty_epoch, coverage.snapshot_exact
  FROM tenant_pii_scan_coverage coverage
 WHERE coverage.tenant_id=$2::uuid`, eraseID, tenantID).
		Scan(&orphanCount, &deleteDirtyAfter, &deleteExact); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = workerTx.Rollback(ctx)
	if orphanCount != 0 {
		t.Fatalf("erasure left %d queue/state rows", orphanCount)
	}
	if deleteDirtyAfter != deleteDirtyBefore+1 || deleteExact {
		t.Fatalf("erasure coverage dirty=%d->%d exact=%t", deleteDirtyBefore, deleteDirtyAfter, deleteExact)
	}

	// Missing-key state is systemic: claims stop and attempts are preserved.
	reconcileOwner, reconcileToken := uuid.NewString(), uuid.NewString()
	workerTx, err = db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	var reconcileGeneration int64
	if err := workerTx.QueryRow(ctx, `
UPDATE tenant_pii_scan_coverage
   SET reconcile_lease_owner=$2::uuid, reconcile_lease_token=$3::uuid,
       reconcile_lease_expires_at=now()+interval '1 minute'
 WHERE tenant_id=$1::uuid
 RETURNING generation`, tenantID, reconcileOwner, reconcileToken).Scan(&reconcileGeneration); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	staleReconciliation := reconciliationLease{
		TenantID: tenantID, Generation: reconcileGeneration,
		OwnerID: reconcileOwner, Token: reconcileToken, ScanContract: scanContract,
	}
	if err := repo.SetScannerAvailability(ctx, false); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ReconcileTenant(ctx, staleReconciliation, 20); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("unavailable transition did not invalidate reconciliation lease: %v", err)
	}
	var unavailableStatus string
	var remainingReconcileToken *string
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT status, reconcile_lease_token::text
  FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`, []any{tenantID},
		&unavailableStatus, &remainingReconcileToken)
	if unavailableStatus != "unavailable" || remainingReconcileToken != nil {
		t.Fatalf("unavailable status=%q reconcile_token=%v", unavailableStatus, remainingReconcileToken)
	}
	var unavailableDirty int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &unavailableDirty)
	// Production ticks pass an explicit (possibly empty) contract and debounce
	// this transition through the runtime heartbeat. The force-style legacy
	// call is still idempotent at the tenant evidence row.
	if err := repo.SetScannerAvailability(ctx, false); err != nil {
		t.Fatal(err)
	}
	var repeatedUnavailableDirty int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &repeatedUnavailableDirty)
	if repeatedUnavailableDirty != unavailableDirty {
		t.Fatalf("repeated unavailable transition dirtied coverage %d -> %d", unavailableDirty, repeatedUnavailableDirty)
	}
	if unavailableClaims, err := repo.ClaimScanIntents(ctx, uuid.NewString(), time.Minute, 100, scanContract); err != nil || len(unavailableClaims) != 0 {
		t.Fatalf("unavailable claims=%d err=%v", len(unavailableClaims), err)
	}
	if err := repo.SetScannerAvailability(ctx, true); err != nil {
		t.Fatal(err)
	}

	// Under the runtime role an unscoped request sees no queue rows; explicit
	// worker scope can enumerate revision metadata. Skip only on installations
	// that intentionally do not create the standard role.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	rlsTx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rlsTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err == nil {
		var unscoped int
		if err := rlsTx.QueryRow(ctx, `SELECT count(*) FROM subscriber_pii_scan_intents`).Scan(&unscoped); err != nil {
			_ = rlsTx.Rollback(ctx)
			t.Fatal(err)
		}
		if unscoped != 0 {
			_ = rlsTx.Rollback(ctx)
			t.Fatalf("unscoped app role saw %d intents", unscoped)
		}
		var unscopedRuntime int
		if err := rlsTx.QueryRow(ctx, `SELECT count(*) FROM pii_scan_runtime_contract`).Scan(&unscopedRuntime); err != nil {
			_ = rlsTx.Rollback(ctx)
			t.Fatal(err)
		}
		if unscopedRuntime != 0 {
			_ = rlsTx.Rollback(ctx)
			t.Fatalf("unscoped app role saw %d runtime contract rows", unscopedRuntime)
		}
		if _, err := rlsTx.Exec(ctx, `SELECT set_config('app.outbox_worker','true',true)`); err != nil {
			_ = rlsTx.Rollback(ctx)
			t.Fatal(err)
		}
		var workerVisible int
		if err := rlsTx.QueryRow(ctx, `SELECT count(*) FROM subscriber_pii_scan_intents`).Scan(&workerVisible); err != nil {
			_ = rlsTx.Rollback(ctx)
			t.Fatal(err)
		}
		if workerVisible == 0 {
			_ = rlsTx.Rollback(ctx)
			t.Fatal("worker scope could not see any intents")
		}
		var workerRuntime int
		if err := rlsTx.QueryRow(ctx, `SELECT count(*) FROM pii_scan_runtime_contract`).Scan(&workerRuntime); err != nil {
			_ = rlsTx.Rollback(ctx)
			t.Fatal(err)
		}
		if workerRuntime != 1 {
			_ = rlsTx.Rollback(ctx)
			t.Fatalf("worker scope saw %d runtime contract rows, want 1", workerRuntime)
		}
	}
	_ = rlsTx.Rollback(ctx)
}

func TestCoveragePipeline_WriteBoundaryRevisionZeroAndStatementBatching(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	_, scanContract := activateCoverageTestContract(t, ctx, repo)
	enabled := true

	// No config is a supported, cheap default. Relevant writes still advance the
	// logical revision, but never depend on a nullable SELECT INTO result and do
	// not create auxiliary coverage/state/intent rows.
	noConfigTenant := uuid.NewString()
	seedTenant(t, pool, noConfigTenant)
	subscriberID := insertCoverageSubscriber(t, pool, noConfigTenant, "no config")
	tx, err := db.WithTenant(ctx, pool, noConfigTenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET display_name='relevant change'
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, noConfigTenant, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("no-config relevant update failed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET engagement_score=42, engagement_score_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, noConfigTenant, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("no-config computed update failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var revision int64
	var coverageRows, stateRows, intentRows int
	mustTenantScan(t, ctx, pool, noConfigTenant, `
SELECT subscriber.pii_scan_revision,
       (SELECT count(*) FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid)
  FROM subscribers subscriber
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`,
		[]any{noConfigTenant, subscriberID}, &revision, &coverageRows, &stateRows, &intentRows)
	if revision != 2 || coverageRows != 0 || stateRows != 0 || intentRows != 0 {
		t.Fatalf("no-config boundary revision=%d coverage=%d states=%d intents=%d", revision, coverageRows, stateRows, intentRows)
	}

	// A write whose AFTER trigger has finished while no config exists must fence
	// the first enable until commit. Otherwise reconciliation can see zero rows,
	// publish exact, and let the unqueued subscriber commit afterward.
	enableFenceTenant := uuid.NewString()
	seedTenant(t, pool, enableFenceTenant)
	writerTx, err := db.WithTenant(ctx, pool, enableFenceTenant)
	if err != nil {
		t.Fatal(err)
	}
	var enableFenceSubscriber string
	if err := writerTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,display_name)
VALUES ($1::uuid,$2,'unconfirmed','unknown','enable fence')
RETURNING id::text`, enableFenceTenant, fmt.Sprintf("enable-fence-%s@example.test", uuid.NewString())).
		Scan(&enableFenceSubscriber); err != nil {
		_ = writerTx.Rollback(ctx)
		t.Fatal(err)
	}
	enableDone := make(chan error, 1)
	go func() {
		_, enableErr := repo.UpsertScanConfig(ctx, enableFenceTenant, UpdateScanConfigInput{ScanEnabled: &enabled})
		enableDone <- enableErr
	}()
	select {
	case enableErr := <-enableDone:
		_ = writerTx.Rollback(ctx)
		t.Fatalf("enable escaped uncommitted subscriber fence: %v", enableErr)
	case <-time.After(100 * time.Millisecond):
	}
	if err := writerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case enableErr := <-enableDone:
		if enableErr != nil {
			t.Fatal(enableErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("enable did not resume after subscriber commit")
	}
	fenceWorker := NewCoverageWorker(repo, newTestDetector(t))
	fenceWorker.LeaseTTL = 2 * time.Second
	fenceWorker.HandlerTimeout = time.Second
	fenceWorker.ReconciliationTimeout = time.Second
	for tick := 0; tick < 10; tick++ {
		if _, err := fenceWorker.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		var exact bool
		var total, states int
		mustTenantScan(t, ctx, pool, enableFenceTenant, `
SELECT coverage.snapshot_exact, coverage.total_subscribers::int,
       (SELECT count(*) FROM subscriber_pii_scan_states
         WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid)
  FROM tenant_pii_scan_coverage coverage
 WHERE coverage.tenant_id=$1::uuid`, []any{enableFenceTenant, enableFenceSubscriber}, &exact, &total, &states)
		if exact && total == 1 && states == 1 {
			break
		}
		if tick == 9 {
			t.Fatalf("enable fence did not cover committed row exact=%t total=%d states=%d", exact, total, states)
		}
	}

	// A scoring-style workspace sweep changes no scan revision and dirties no
	// enabled coverage evidence. A relevant text write immediately afterward
	// advances and coalesces normally.
	if _, err := repo.UpsertScanConfig(ctx, noConfigTenant, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	worker := NewCoverageWorker(repo, newTestDetector(t))
	worker.LeaseTTL = 2 * time.Second
	worker.HandlerTimeout = time.Second
	worker.ReconciliationTimeout = time.Second
	worker.ReconcileBatch = 20
	worker.ReconcileTenants = 10
	worker.ClaimBatch = 20
	if _, err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var beforeRevision, beforeTarget, beforeDirty int64
	readPendingEvidence := func() error {
		readTx, readErr := db.WithTenant(ctx, pool, noConfigTenant)
		if readErr != nil {
			return readErr
		}
		defer func() { _ = readTx.Rollback(ctx) }()
		readErr = readTx.QueryRow(ctx, `
SELECT subscriber.pii_scan_revision, intent.target_revision, coverage.dirty_epoch
  FROM subscribers subscriber
  JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=subscriber.tenant_id AND intent.subscriber_id=subscriber.id
  JOIN tenant_pii_scan_coverage coverage ON coverage.tenant_id=subscriber.tenant_id
	WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`, noConfigTenant, subscriberID).
			Scan(&beforeRevision, &beforeTarget, &beforeDirty)
		if readErr != nil {
			return readErr
		}
		return readTx.Commit(ctx)
	}
	if err := readPendingEvidence(); err != nil {
		// The first tick may have drained the intent. Create a relevant target that
		// remains pending while the computed-write invariant is measured.
		tx, txErr := db.WithTenant(ctx, pool, noConfigTenant)
		if txErr != nil {
			t.Fatal(txErr)
		}
		_, txErr = tx.Exec(ctx, `UPDATE subscribers SET display_name='pending target' WHERE tenant_id=$1::uuid AND id=$2::uuid`, noConfigTenant, subscriberID)
		if txErr == nil {
			txErr = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if txErr != nil {
			t.Fatal(txErr)
		}
		if err := readPendingEvidence(); err != nil {
			t.Fatal(err)
		}
	}
	tx, err = db.WithTenant(ctx, pool, noConfigTenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET engagement_score=engagement_score+1, engagement_score_at=now()
 WHERE tenant_id=$1::uuid`, noConfigTenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var afterRevision, afterTarget, afterDirty int64
	mustTenantScan(t, ctx, pool, noConfigTenant, `
SELECT subscriber.pii_scan_revision, intent.target_revision, coverage.dirty_epoch
  FROM subscribers subscriber
  JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=subscriber.tenant_id AND intent.subscriber_id=subscriber.id
  JOIN tenant_pii_scan_coverage coverage ON coverage.tenant_id=subscriber.tenant_id
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`,
		[]any{noConfigTenant, subscriberID}, &afterRevision, &afterTarget, &afterDirty)
	if afterRevision != beforeRevision || afterTarget != beforeTarget || afterDirty != beforeDirty {
		t.Fatalf("computed write created PII work before=(%d,%d,%d) after=(%d,%d,%d)",
			beforeRevision, beforeTarget, beforeDirty, afterRevision, afterTarget, afterDirty)
	}
	tx, err = db.WithTenant(ctx, pool, noConfigTenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE subscribers SET display_name='relevant again' WHERE tenant_id=$1::uuid AND id=$2::uuid`, noConfigTenant, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	mustTenantScan(t, ctx, pool, noConfigTenant, `
SELECT subscriber.pii_scan_revision, intent.target_revision, coverage.dirty_epoch
  FROM subscribers subscriber
  JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=subscriber.tenant_id AND intent.subscriber_id=subscriber.id
  JOIN tenant_pii_scan_coverage coverage ON coverage.tenant_id=subscriber.tenant_id
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`,
		[]any{noConfigTenant, subscriberID}, &afterRevision, &afterTarget, &afterDirty)
	if afterRevision != beforeRevision+1 || afterTarget != afterRevision || afterDirty != beforeDirty+1 {
		t.Fatalf("relevant write evidence revision=%d target=%d dirty=%d", afterRevision, afterTarget, afterDirty)
	}

	// Simulate a row left at physical revision 0 by an interrupted pre-1762
	// rollout. Reconciliation and snapshot loading both treat it as baseline 1.
	zeroTenant := uuid.NewString()
	seedTenant(t, pool, zeroTenant)
	zeroID := insertCoverageSubscriber(t, pool, zeroTenant, "revision zero")
	admin := newCoverageAdminPool(t, ctx)
	adminTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Plain assignments, not `:=`: a shadowed err here silently dropped both
	// the SET LOCAL and UPDATE failures, so a fixture that never reached
	// revision 0 still committed and the test ran against the wrong row.
	_, err = adminTx.Exec(ctx, `SET LOCAL session_replication_role='replica'`)
	if err == nil {
		_, err = adminTx.Exec(ctx, `UPDATE subscribers SET pii_scan_revision=0 WHERE tenant_id=$1::uuid AND id=$2::uuid`, zeroTenant, zeroID)
	}
	if err == nil {
		err = adminTx.Commit(ctx)
	} else {
		_ = adminTx.Rollback(ctx)
	}
	if err != nil {
		t.Fatalf("seed rolling-upgrade revision zero: %v", err)
	}
	if _, err := repo.UpsertScanConfig(ctx, zeroTenant, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	leases, err := repo.ClaimReconciliations(ctx, uuid.NewString(), time.Minute, 20, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	var zeroLease reconciliationLease
	for _, lease := range leases {
		if lease.TenantID == zeroTenant {
			zeroLease = lease
		}
	}
	if zeroLease.TenantID == "" {
		t.Fatal("revision-zero tenant reconciliation was not claimable")
	}
	if _, err := repo.ReconcileTenant(ctx, zeroLease, 20); err != nil {
		t.Fatal(err)
	}
	snapshot, err := repo.loadSubscriberSnapshot(ctx, zeroTenant, zeroID, nil)
	if err != nil || snapshot.Revision != 1 {
		t.Fatalf("revision-zero snapshot=%+v err=%v", snapshot, err)
	}
	var zeroObserved, zeroTarget int64
	mustTenantScan(t, ctx, pool, zeroTenant, `
SELECT state.observed_revision, intent.target_revision
  FROM subscriber_pii_scan_states state
  JOIN subscriber_pii_scan_intents intent USING (tenant_id, subscriber_id)
 WHERE state.tenant_id=$1::uuid AND state.subscriber_id=$2::uuid`,
		[]any{zeroTenant, zeroID}, &zeroObserved, &zeroTarget)
	if zeroObserved != 1 || zeroTarget != 1 {
		t.Fatalf("revision-zero baseline observed=%d target=%d", zeroObserved, zeroTarget)
	}

	// Large disabled/no-config statements create zero auxiliary writes. The same
	// enabled INSERT statement dirties the tenant row exactly once, not per row.
	disabledBulkTenant := uuid.NewString()
	seedTenant(t, pool, disabledBulkTenant)
	mustTenantExec(t, ctx, pool, disabledBulkTenant, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,display_name)
SELECT $1::uuid, 'disabled-bulk-'||n||'@example.test', 'unconfirmed', 'unknown', 'v1'
	FROM generate_series(1,1000) n`, disabledBulkTenant)
	mustTenantExec(t, ctx, pool, disabledBulkTenant, `
UPDATE subscribers SET display_name='v2'
 WHERE tenant_id=$1::uuid`, disabledBulkTenant)
	mustTenantScan(t, ctx, pool, disabledBulkTenant, `
SELECT (SELECT count(*) FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid),
       (SELECT min(pii_scan_revision) FROM subscribers WHERE tenant_id=$1::uuid)`,
		[]any{disabledBulkTenant}, &coverageRows, &stateRows, &intentRows, &revision)
	if coverageRows != 0 || stateRows != 0 || intentRows != 0 || revision != 2 {
		t.Fatalf("disabled bulk coverage=%d states=%d intents=%d min_revision=%d", coverageRows, stateRows, intentRows, revision)
	}

	enabledBulkTenant := uuid.NewString()
	seedTenant(t, pool, enabledBulkTenant)
	if _, err := repo.UpsertScanConfig(ctx, enabledBulkTenant, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	var dirtyBefore int64
	mustTenantScan(t, ctx, pool, enabledBulkTenant,
		`SELECT dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{enabledBulkTenant}, &dirtyBefore)
	mustTenantExec(t, ctx, pool, enabledBulkTenant, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,display_name)
SELECT $1::uuid, 'enabled-bulk-'||n||'@example.test', 'unconfirmed', 'unknown', 'v1'
	FROM generate_series(1,1000) n`, enabledBulkTenant)
	mustTenantScan(t, ctx, pool, enabledBulkTenant, `
SELECT coverage.dirty_epoch,
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid)
  FROM tenant_pii_scan_coverage coverage WHERE coverage.tenant_id=$1::uuid`,
		[]any{enabledBulkTenant}, &afterDirty, &stateRows, &intentRows)
	if afterDirty != dirtyBefore+1 || stateRows != 1000 || intentRows != 1000 {
		t.Fatalf("enabled statement batching dirty=%d->%d states=%d intents=%d", dirtyBefore, afterDirty, stateRows, intentRows)
	}
	mustTenantExec(t, ctx, pool, enabledBulkTenant,
		`DELETE FROM subscribers WHERE tenant_id=$1::uuid`, enabledBulkTenant)
	var deleteDirty int64
	mustTenantScan(t, ctx, pool, enabledBulkTenant, `
SELECT coverage.dirty_epoch,
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid)
  FROM tenant_pii_scan_coverage coverage WHERE coverage.tenant_id=$1::uuid`,
		[]any{enabledBulkTenant}, &deleteDirty, &stateRows, &intentRows)
	if deleteDirty != afterDirty+1 || stateRows != 0 || intentRows != 0 {
		t.Fatalf("enabled delete batching dirty=%d->%d states=%d intents=%d", afterDirty, deleteDirty, stateRows, intentRows)
	}
}

func TestCoveragePipeline_ProjectionBytesAndFieldNameCollisions(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	fields := map[string]any{
		"_listmonk_id":                   "999-99-9999",
		"_private_note":                  "219-09-9999",
		"aa_control\x01name":             "control-marker",
		"aa_control_name":                "underscore-marker",
		"aa_multibyte":                   strings.Repeat("界", MaxScanFieldBytes/3+100),
		strings.Repeat("long", 80) + "x": "long-x-marker",
		strings.Repeat("long", 80) + "y": "long-y-marker",
	}
	for i := 0; i < MaxScanFields+25; i++ {
		fields[fmt.Sprintf("zz_%04d", i)] = fmt.Sprintf("value-%d", i)
	}
	payload, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	var subscriberID string
	insertTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if err := insertTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,custom_fields)
VALUES ($1::uuid,$2,'unconfirmed','unknown',$3::jsonb)
RETURNING id::text`, tenantID, fmt.Sprintf("projection-%s@example.test", uuid.NewString()), payload).Scan(&subscriberID); err != nil {
		_ = insertTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := insertTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := repo.loadSubscriberSnapshot(ctx, tenantID, subscriberID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.CandidateFields != MaxScanFields+1 || len(snapshot.Fields) != MaxScanFields {
		t.Fatalf("projection fields=%d candidates=%d transport_truncated=%t", len(snapshot.Fields), snapshot.CandidateFields, snapshot.TransportTruncated)
	}
	values := map[string]bool{}
	for name, raw := range snapshot.Fields {
		if utf8Len := len(name); utf8Len == 0 || utf8.RuneCountInString(name) > 256 {
			t.Fatalf("unsafe normalized field name %q", name)
		}
		value, ok := raw.(string)
		if !ok {
			t.Fatalf("field %q has non-string projection %T", name, raw)
		}
		if len(value) > MaxScanFieldBytes+1 {
			t.Fatalf("field %q transported %d bytes", name, len(value))
		}
		values[value] = true
	}
	for _, marker := range []string{"control-marker", "underscore-marker", "long-x-marker", "long-y-marker"} {
		if !values[marker] {
			t.Fatalf("normalization/truncation collision overwrote %q", marker)
		}
	}
	result := newTestDetector(t).ScanFields(tenantID, snapshot.Fields, snapshot.Declared)
	if err := applySnapshotCoverageLimits(snapshot, &result); err != nil {
		t.Fatal(err)
	}
	wantOver := snapshot.CandidateFields - MaxScanFields
	if !result.Truncated || result.FieldsOverLimit != wantOver {
		t.Fatalf("bounded result truncated=%t fields_over=%d want=%d", result.Truncated, result.FieldsOverLimit, wantOver)
	}
	if result.FieldsReserved != 1 {
		t.Fatalf("namespaced exact platform key reserved=%d want=1", result.FieldsReserved)
	}
	foundPrivateNote := false
	for _, detection := range result.Detections {
		if detection.FieldName == "custom_fields._listmonk_id" {
			t.Fatal("namespaced platform key produced a finding")
		}
		if detection.FieldName == "custom_fields._private_note" && detection.DetectedType == TypeSSN {
			foundPrivateNote = true
		}
	}
	if !foundPrivateNote {
		t.Fatal("arbitrary namespaced underscore field was not scanned")
	}

	assertJSONBoundaryRejected := func(label string, document any) {
		t.Helper()
		encoded, marshalErr := json.Marshal(document)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		tx, txErr := db.WithTenant(ctx, pool, tenantID)
		if txErr != nil {
			t.Fatal(txErr)
		}
		_, execErr := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,custom_fields)
VALUES ($1::uuid,$2,'unconfirmed','unknown',$3::jsonb)`,
			tenantID, fmt.Sprintf("projection-reject-%s-%s@example.test", label, uuid.NewString()), encoded)
		_ = tx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if !errors.As(execErr, &pgErr) || pgErr.Code != "23514" ||
			pgErr.ConstraintName != "subscribers_pii_projection_json_bounds" {
			t.Fatalf("%s boundary error=%v pg=%+v", label, execErr, pgErr)
		}
	}
	tooManyChildren := make(map[string]string, 1025)
	for index := 0; index < 1025; index++ {
		tooManyChildren[fmt.Sprintf("key_%04d", index)] = "bounded"
	}
	assertJSONBoundaryRejected("children", tooManyChildren)
	var tooDeep any = "leaf"
	for depth := 0; depth < 17; depth++ {
		tooDeep = map[string]any{"child": tooDeep}
	}
	assertJSONBoundaryRejected("depth", tooDeep)

	// Each persisted JSON document is independently valid and under 2 MiB, but
	// the combined current-profile projection exceeds the worker transport cap.
	// The reader must close its row stream cleanly, return a bounded snapshot,
	// and surface the truncation instead of allocating the full profile.
	largeDocument := func(namespace string) map[string]string {
		document := make(map[string]string, 27)
		for index := 0; index < 27; index++ {
			document[fmt.Sprintf("%s_%02d", namespace, index)] =
				fmt.Sprintf("%s-%02d-", namespace, index) + strings.Repeat("abcdefghij", 7<<10)
		}
		return document
	}
	customPayload, err := json.Marshal(largeDocument("custom"))
	if err != nil {
		t.Fatal(err)
	}
	mergePayload, err := json.Marshal(largeDocument("merge"))
	if err != nil {
		t.Fatal(err)
	}
	activityPayload, err := json.Marshal(largeDocument("activity"))
	if err != nil {
		t.Fatal(err)
	}
	largeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var largeSubscriberID string
	if err := largeTx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id,email,status,consent_source,
    custom_fields,merge_fields,activity_summary
)
VALUES ($1::uuid,$2,'unconfirmed','unknown',$3::jsonb,$4::jsonb,$5::jsonb)
RETURNING id::text`, tenantID, fmt.Sprintf("projection-large-%s@example.test", uuid.NewString()),
		customPayload, mergePayload, activityPayload).Scan(&largeSubscriberID); err != nil {
		_ = largeTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := largeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	largeSnapshot, err := repo.loadSubscriberSnapshot(ctx, tenantID, largeSubscriberID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !largeSnapshot.TransportTruncated || largeSnapshot.TransportBytes > MaxScanSubscriberBytes ||
		len(largeSnapshot.Fields) >= largeSnapshot.CandidateFields {
		t.Fatalf("aggregate transport fields=%d candidates=%d bytes=%d truncated=%t",
			len(largeSnapshot.Fields), largeSnapshot.CandidateFields,
			largeSnapshot.TransportBytes, largeSnapshot.TransportTruncated)
	}
}

func TestCoveragePipeline_LeaseABAExhaustionSweepAndConfigDelete(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	_, scanContract := activateCoverageTestContract(t, ctx, repo)
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "lease ABA 123-45-6789")
	// Make the target deterministic even when a shared integration database has
	// other tenants' pending work.
	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx, `UPDATE subscriber_pii_scan_intents SET available_at='2000-01-01'::timestamptz WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	owner := uuid.NewString()
	claims, err := repo.ClaimScanIntents(ctx, owner, time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	var first ScanIntent
	for _, claim := range claims {
		if claim.SubscriberID == subscriberID {
			first = claim
		}
	}
	if first.LeaseToken == "" {
		t.Fatal("first lease not claimed")
	}
	workerTx, err = db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx, `UPDATE subscriber_pii_scan_intents SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	claims, err = repo.ClaimScanIntents(ctx, owner, time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	var second ScanIntent
	for _, claim := range claims {
		if claim.SubscriberID == subscriberID {
			second = claim
		}
	}
	if second.LeaseToken == "" || second.LeaseToken == first.LeaseToken {
		t.Fatalf("reclaim token first=%q second=%q", first.LeaseToken, second.LeaseToken)
	}
	staleSnapshot, err := repo.loadSubscriberSnapshot(ctx, tenantID, subscriberID, nil)
	if err != nil {
		t.Fatal(err)
	}
	detector := newTestDetector(t)
	staleResult := detector.ScanFields(tenantID, staleSnapshot.Fields, staleSnapshot.Declared)
	if _, _, err := repo.CompleteScan(ctx, first, staleSnapshot, staleResult, detector.FingerprintKeyVersion()); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale same-owner completion error=%v", err)
	}
	if _, err := repo.FailScanIntent(ctx, first, "detector_failure", time.Now()); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale same-owner fail error=%v", err)
	}
	if err := repo.RenewScanLease(ctx, first, time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale same-owner renew error=%v", err)
	}
	if len(staleResult.Detections) == 0 {
		t.Fatal("provenance fixture produced no detection")
	}
	mismatchedResult := staleResult
	mismatchedResult.Detections = append([]Detection(nil), staleResult.Detections...)
	mismatchedResult.Detections[0].FingerprintKeyVersion = "different-key-v1"
	if _, _, err := repo.CompleteScan(ctx, second, staleSnapshot, mismatchedResult, detector.FingerprintKeyVersion()); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("mismatched finding/state fingerprint provenance error=%v", err)
	}

	workerTx, err = db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents
   SET attempts=max_attempts, lease_expires_at=now()-interval '1 second'
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	claims, err = repo.ClaimScanIntents(ctx, uuid.NewString(), time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	for _, claim := range claims {
		if claim.SubscriberID == subscriberID {
			t.Fatal("expired max-attempt lease was reclaimed instead of swept")
		}
	}
	var intentStatus, stateStatus, errorCode string
	var token *string
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT intent.status, state.state, intent.last_error_code, intent.lease_token::text
  FROM subscriber_pii_scan_intents intent
  JOIN subscriber_pii_scan_states state USING (tenant_id,subscriber_id)
 WHERE intent.tenant_id=$1::uuid AND intent.subscriber_id=$2::uuid`,
		[]any{tenantID, subscriberID}, &intentStatus, &stateStatus, &errorCode, &token)
	if intentStatus != "dead_letter" || stateStatus != "dead_letter" || errorCode != "lease_lost" || token != nil {
		t.Fatalf("exhaustion sweep intent=%s state=%s code=%s token=%v", intentStatus, stateStatus, errorCode, token)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tenant_pii_scan_config WHERE tenant_id=$1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	postDeleteID := insertCoverageSubscriber(t, pool, tenantID, "after config delete")
	var enabledAfterDelete bool
	var postDeleteStates, postDeleteIntents int
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT coverage.scan_enabled, coverage.status,
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid)
	  FROM tenant_pii_scan_coverage coverage WHERE coverage.tenant_id=$1::uuid`,
		[]any{tenantID, postDeleteID}, &enabledAfterDelete, &intentStatus, &postDeleteStates, &postDeleteIntents)
	if enabledAfterDelete || intentStatus != "disabled" || postDeleteStates != 0 || postDeleteIntents != 0 {
		t.Fatalf("config delete enabled=%t status=%s states=%d intents=%d", enabledAfterDelete, intentStatus, postDeleteStates, postDeleteIntents)
	}
}

func TestCoveragePipeline_DisableRevokesInFlightLease(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	detector, scanContract := activateCoverageTestContract(t, ctx, repo)
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "disable fence 123-45-6789")
	mustWorkerExec(t, ctx, pool, `
UPDATE subscriber_pii_scan_intents
   SET available_at='2000-01-01'::timestamptz
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID)
	claims, err := repo.ClaimScanIntents(ctx, uuid.NewString(), time.Minute, 100, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	var claim ScanIntent
	for _, candidate := range claims {
		if candidate.TenantID == tenantID && candidate.SubscriberID == subscriberID {
			claim = candidate
			break
		}
	}
	if claim.LeaseToken == "" {
		t.Fatal("in-flight disable fixture was not claimed")
	}

	// A tenant-level coverage update may commit after the subscriber row is
	// locked but before lease/coverage authorization. This used to make the
	// claimed REPEATABLE READ snapshot fail with SQLSTATE 40001. Hold coverage,
	// prove the value fetch is waiting behind it, advance non-contract metadata,
	// and require the bounded READ COMMITTED + subscriber SHARE boundary to
	// continue without consuming a retry.
	coverageBlocker, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = coverageBlocker.Rollback(context.Background()) }()
	var coverageBlockerPID int
	if err := coverageBlocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&coverageBlockerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := coverageBlocker.Exec(ctx, `
SELECT status
  FROM tenant_pii_scan_coverage
 WHERE tenant_id=$1::uuid
 FOR UPDATE`, tenantID); err != nil {
		t.Fatal(err)
	}
	type snapshotResult struct {
		snapshot *SubscriberSnapshot
		err      error
	}
	snapshotDone := make(chan snapshotResult, 1)
	go func() {
		loaded, loadErr := repo.LoadClaimedSubscriberSnapshot(ctx, claim)
		snapshotDone <- snapshotResult{snapshot: loaded, err: loadErr}
	}()
	admin := newCoverageAdminPool(t, ctx)
	snapshotBlocked := false
	for attempt := 0; attempt < 200; attempt++ {
		if err := admin.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_stat_activity activity
     WHERE activity.pid <> $1
       AND activity.wait_event_type = 'Lock'
       AND $1 = ANY(pg_blocking_pids(activity.pid))
)`, coverageBlockerPID).Scan(&snapshotBlocked); err != nil {
			t.Fatal(err)
		}
		if snapshotBlocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !snapshotBlocked {
		_ = coverageBlocker.Rollback(ctx)
		result := <-snapshotDone
		t.Fatalf("claimed snapshot did not reach coverage fence: %+v", result)
	}
	if _, err := coverageBlocker.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET dirty_epoch=dirty_epoch+1, updated_at=now()
 WHERE tenant_id=$1::uuid`, tenantID); err != nil {
		t.Fatal(err)
	}
	if err := coverageBlocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	loaded := <-snapshotDone
	if loaded.err != nil || loaded.snapshot == nil {
		t.Fatalf("claimed snapshot after concurrent coverage update=%+v", loaded)
	}
	snapshot := loaded.snapshot
	result := detector.ScanFields(tenantID, snapshot.Fields, snapshot.Declared)
	if len(result.Detections) == 0 {
		t.Fatal("in-flight disable fixture produced no detection")
	}

	disabled := false
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.LoadClaimedSubscriberSnapshot(ctx, claim); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("disabled value fetch error=%v, want ErrLeaseLost", err)
	}
	if err := repo.RenewScanLease(ctx, claim, time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("disabled renew error=%v, want ErrLeaseLost", err)
	}
	if _, _, err := repo.CompleteScan(ctx, claim, snapshot, result, detector.FingerprintKeyVersion()); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("disabled completion error=%v, want ErrLeaseLost", err)
	}
	if _, err := repo.FailScanIntent(ctx, claim, "detector_failure", time.Now()); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("disabled failure error=%v, want ErrLeaseLost", err)
	}
	page, err := repo.ListFindingsForSubscriber(ctx, tenantID, subscriberID, FindingFilter{})
	if err != nil || page.Total != 0 {
		t.Fatalf("disabled worker retained findings total=%d err=%v", page.Total, err)
	}
	var intentStatus, stateStatus, coverageStatus string
	var attempts int
	var leaseToken *string
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT intent.status, intent.attempts, intent.lease_token::text,
       state.state, coverage.status
  FROM subscriber_pii_scan_intents intent
  JOIN subscriber_pii_scan_states state USING (tenant_id,subscriber_id)
  JOIN tenant_pii_scan_coverage coverage USING (tenant_id)
 WHERE intent.tenant_id=$1::uuid AND intent.subscriber_id=$2::uuid`,
		[]any{tenantID, subscriberID}, &intentStatus, &attempts, &leaseToken,
		&stateStatus, &coverageStatus)
	if intentStatus != "pending" || attempts != 0 || leaseToken != nil ||
		stateStatus != "pending" || coverageStatus != "disabled" {
		t.Fatalf("disabled lease intent=%s attempts=%d token=%v state=%s coverage=%s",
			intentStatus, attempts, leaseToken, stateStatus, coverageStatus)
	}
}

func TestCoveragePipeline_ClaimCrossingDisableRollsBackBeforeValueFetch(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	_, scanContract := activateCoverageTestContract(t, ctx, repo)
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "crossing disable must never be fetched 123-45-6789")
	mustWorkerExec(t, ctx, pool, `
UPDATE subscriber_pii_scan_intents
   SET available_at='2000-01-01'::timestamptz
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID)

	// Hold the state row so ClaimScanIntents has already made its intent lease
	// uncommitted but cannot yet reach tenant coverage. The disable transaction
	// therefore sees the pre-claim pending row and must still win safely.
	blocker, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	var blockerPID int
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	locked, err := blocker.Exec(ctx, `
SELECT state
  FROM subscriber_pii_scan_states
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
	FOR UPDATE`, tenantID, subscriberID)
	if err != nil {
		t.Fatal(err)
	}
	if locked.RowsAffected() != 1 {
		t.Fatalf("state-row fence affected %d rows", locked.RowsAffected())
	}
	type claimResult struct {
		intents []ScanIntent
		err     error
	}
	claimDone := make(chan claimResult, 1)
	go func() {
		intents, claimErr := repo.ClaimScanIntents(ctx, uuid.NewString(), time.Minute, 100, scanContract)
		claimDone <- claimResult{intents: intents, err: claimErr}
	}()

	admin := newCoverageAdminPool(t, ctx)
	claimBlocked := false
	for attempt := 0; attempt < 200; attempt++ {
		if err := admin.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_stat_activity activity
	     WHERE activity.pid <> $1
	       AND activity.wait_event_type = 'Lock'
	       AND $1 = ANY(pg_blocking_pids(activity.pid))
)`, blockerPID).Scan(&claimBlocked); err != nil {
			t.Fatal(err)
		}
		if claimBlocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !claimBlocked {
		_ = blocker.Rollback(ctx)
		result := <-claimDone
		t.Fatalf("claim did not reach deterministic state-row fence: %+v", result)
	}

	disableDone := make(chan error, 1)
	go func() {
		disabled := false
		_, disableErr := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &disabled})
		disableDone <- disableErr
	}()
	disableFinishedBeforeRelease := false
	var disableErr error
	select {
	case disableErr = <-disableDone:
		disableFinishedBeforeRelease = true
	case <-time.After(250 * time.Millisecond):
		// PostgreSQL may wait for the in-flight intent tuple before deciding
		// whether the disable trigger's leased-row predicate matches. That ordering
		// is safe too: the claim commits first and disable then revokes it.
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-claimDone
	if !disableFinishedBeforeRelease {
		disableErr = <-disableDone
	}
	if disableErr != nil {
		t.Fatal(disableErr)
	}
	if result.err != nil {
		t.Fatalf("crossing claim error=%v", result.err)
	}
	targetClaimSeen := false
	for _, crossingClaim := range result.intents {
		if crossingClaim.TenantID != tenantID || crossingClaim.SubscriberID != subscriberID {
			// ClaimScanIntents is intentionally cross-tenant. Other enabled tenants
			// returned by this batch are unrelated to the target tenant's opt-out.
			continue
		}
		targetClaimSeen = true
		if _, err := repo.LoadClaimedSubscriberSnapshot(ctx, crossingClaim); !errors.Is(err, ErrLeaseLost) {
			t.Fatalf("post-disable target value fetch error=%v, want ErrLeaseLost", err)
		}
	}
	if !targetClaimSeen {
		t.Fatalf("crossing batch omitted blocked target claim: %+v", result.intents)
	}

	var intentStatus, stateStatus, coverageStatus string
	var attempts int
	var leaseToken *string
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT intent.status, intent.attempts, intent.lease_token::text,
       state.state, coverage.status
  FROM subscriber_pii_scan_intents intent
  JOIN subscriber_pii_scan_states state USING (tenant_id,subscriber_id)
  JOIN tenant_pii_scan_coverage coverage USING (tenant_id)
 WHERE intent.tenant_id=$1::uuid AND intent.subscriber_id=$2::uuid`,
		[]any{tenantID, subscriberID}, &intentStatus, &attempts, &leaseToken,
		&stateStatus, &coverageStatus)
	if intentStatus != "pending" || attempts != 0 || leaseToken != nil ||
		stateStatus != "pending" || coverageStatus != "disabled" {
		t.Fatalf("crossing claim intent=%s attempts=%d token=%v state=%s coverage=%s",
			intentStatus, attempts, leaseToken, stateStatus, coverageStatus)
	}
}

func TestCoveragePipeline_DeleteCascadeUsesWorkerLockOrder(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	_, _ = activateCoverageTestContract(t, ctx, repo)
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "delete cascade lock order")

	workerTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workerTx.Rollback(context.Background()) }()
	if _, err := workerTx.Exec(ctx, `
SELECT status
  FROM subscriber_pii_scan_intents
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
 FOR UPDATE`, tenantID, subscriberID); err != nil {
		t.Fatal(err)
	}

	deletePID := make(chan int, 1)
	deleteDone := make(chan error, 1)
	go func() {
		deleteTx, deleteErr := db.WithTenant(ctx, pool, tenantID)
		if deleteErr != nil {
			deleteDone <- deleteErr
			return
		}
		defer func() { _ = deleteTx.Rollback(context.Background()) }()
		var pid int
		if deleteErr = deleteTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); deleteErr != nil {
			deleteDone <- deleteErr
			return
		}
		deletePID <- pid
		_, deleteErr = deleteTx.Exec(ctx, `
DELETE FROM subscribers
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID)
		if deleteErr == nil {
			deleteErr = deleteTx.Commit(ctx)
		}
		deleteDone <- deleteErr
	}()

	pid := <-deletePID
	admin := newCoverageAdminPool(t, ctx)
	deleteBlocked := false
	for attempt := 0; attempt < 200; attempt++ {
		var waitEventType *string
		if err := admin.QueryRow(ctx, `
SELECT wait_event_type
  FROM pg_stat_activity
 WHERE pid=$1`, pid).Scan(&waitEventType); err != nil {
			t.Fatal(err)
		}
		if waitEventType != nil && *waitEventType == "Lock" {
			deleteBlocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !deleteBlocked {
		_ = workerTx.Rollback(ctx)
		t.Fatal("delete did not block behind the intent FK cascade lock")
	}

	_, stateErr := workerTx.Exec(ctx, `
UPDATE subscriber_pii_scan_states
   SET state='pending', updated_at=now()
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID)
	if stateErr != nil {
		_ = workerTx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if errors.As(stateErr, &pgErr) && pgErr.Code == "40P01" {
			t.Fatalf("delete cascade deadlocked with intent-to-state worker order: %v", stateErr)
		}
		t.Fatal(stateErr)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if deleteErr := <-deleteDone; deleteErr != nil {
		var pgErr *pgconn.PgError
		if errors.As(deleteErr, &pgErr) && pgErr.Code == "40P01" {
			t.Fatalf("delete cascade deadlocked with intent-to-state worker order: %v", deleteErr)
		}
		t.Fatal(deleteErr)
	}
	var subscribers, intents, states int
	mustTenantScan(t, ctx, pool, tenantID, `
SELECT (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid)`,
		[]any{tenantID, subscriberID}, &subscribers, &intents, &states)
	if subscribers != 0 || intents != 0 || states != 0 {
		t.Fatalf("delete cascade subscribers=%d intents=%d states=%d", subscribers, intents, states)
	}
}

func TestCoveragePipeline_MultiPageReconciliationAggregatesOnce(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	_, scanContract := activateCoverageTestContract(t, ctx, repo)
	mustTenantExec(t, ctx, pool, tenantID, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,display_name)
SELECT $1::uuid, 'reconcile-'||n||'@example.test', 'unconfirmed', 'unknown', 'row-'||n
	FROM generate_series(1,25) n`, tenantID)
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	owner := uuid.NewString()
	var staleLease reconciliationLease
	for page := 1; page <= 4; page++ {
		token := uuid.NewString()
		workerTx, err := db.WithWorkerScope(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		var generation int64
		if err := workerTx.QueryRow(ctx, `
UPDATE tenant_pii_scan_coverage
   SET reconcile_lease_owner=$2::uuid, reconcile_lease_token=$3::uuid,
       reconcile_lease_expires_at=now()+interval '1 minute', status='backfilling'
 WHERE tenant_id=$1::uuid
 RETURNING generation`, tenantID, owner, token).Scan(&generation); err != nil {
			_ = workerTx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := workerTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		lease := reconciliationLease{
			TenantID: tenantID, Generation: generation, OwnerID: owner, Token: token,
			ScanContract: scanContract,
		}
		if page == 2 {
			if _, err := repo.ReconcileTenant(ctx, staleLease, 7); !errors.Is(err, ErrLeaseLost) {
				t.Fatalf("stale reconciliation ABA error=%v", err)
			}
		}
		snapshot, err := repo.ReconcileTenant(ctx, lease, 7)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		var cursor *string
		var lastReconciled *time.Time
		var total, states, intents int
		var exact bool
		mustTenantScan(t, ctx, pool, tenantID, `
SELECT reconcile_cursor::text, last_reconciled_at, total_subscribers::int,
       snapshot_exact,
       (SELECT count(*) FROM subscriber_pii_scan_states WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM subscriber_pii_scan_intents WHERE tenant_id=$1::uuid)
  FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`, []any{tenantID},
			&cursor, &lastReconciled, &total, &exact, &states, &intents)
		if page < 4 {
			if snapshot.Status != "backfilling" || snapshot.SnapshotExact || cursor == nil || lastReconciled != nil || total != 0 || states != page*7 || intents != page*7 {
				t.Fatalf("page %d performed premature aggregate snapshot=%+v cursor=%v last=%v total=%d states=%d intents=%d", page, snapshot, cursor, lastReconciled, total, states, intents)
			}
		} else if cursor != nil || lastReconciled == nil || !exact || total != 25 || states != 25 || intents != 25 {
			t.Fatalf("final page snapshot=%+v cursor=%v last=%v exact=%t total=%d states=%d intents=%d", snapshot, cursor, lastReconciled, exact, total, states, intents)
		}
		staleLease = lease
	}
	// Once historical pagination is complete, ordinary pending work drains
	// without re-running the full tenant aggregate for every claim batch.
	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	var ordinaryQueueDefersAggregate bool
	if err := workerTx.QueryRow(ctx, `
SELECT coverage.reconcile_cursor IS NULL
       AND EXISTS (
           SELECT 1 FROM subscriber_pii_scan_intents intent
            WHERE intent.tenant_id=coverage.tenant_id
              AND intent.status IN ('pending','leased')
       )
  FROM tenant_pii_scan_coverage coverage
 WHERE coverage.tenant_id=$1::uuid`, tenantID).Scan(&ordinaryQueueDefersAggregate); err != nil {
		t.Fatal(err)
	}
	if !ordinaryQueueDefersAggregate {
		t.Fatal("completed reconciliation cursor did not defer ordinary pending-queue re-aggregation")
	}
	_ = workerTx.Rollback(ctx)

	// NULL cursor also occurs before the first historical page. An explicit
	// seeded-generation watermark keeps that initial backfill claimable even if
	// ordinary writes make the queue continuously non-empty.
	starvationTenantID := uuid.NewString()
	seedTenant(t, pool, starvationTenantID)
	if _, err := repo.UpsertScanConfig(ctx, starvationTenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	insertCoverageSubscriber(t, pool, starvationTenantID, "ordinary pending traffic")
	leases, err := repo.ClaimReconciliations(ctx, uuid.NewString(), time.Minute, 20, scanContract)
	if err != nil {
		t.Fatal(err)
	}
	claimedInitialSeed := false
	for _, lease := range leases {
		if lease.TenantID == starvationTenantID {
			claimedInitialSeed = true
			break
		}
	}
	if !claimedInitialSeed {
		t.Fatal("initial historical seed starved behind an ordinary pending intent")
	}
}

func TestCoveragePipeline_TruncationPersistsGapAndDeadLetter(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var subscriberID string
	err = tx.QueryRow(ctx, `
WITH fields AS (
    SELECT jsonb_object_agg('field_' || n::text, 'safe value') AS body
      FROM generate_series(1, $2) n
)
INSERT INTO subscribers (tenant_id,email,status,consent_source,custom_fields)
SELECT $1::uuid, $3, 'unconfirmed', 'unknown', fields.body FROM fields
RETURNING id::text`, tenantID, MaxScanFields+1, fmt.Sprintf("truncated-%s@example.test", uuid.NewString())).Scan(&subscriberID)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	boundedSnapshot, err := repo.loadSubscriberSnapshot(ctx, tenantID, subscriberID, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantFieldsOver := boundedSnapshot.CandidateFields - MaxScanFields
	if wantFieldsOver <= 0 {
		t.Fatalf("test fixture did not exceed field cap: %+v", boundedSnapshot)
	}
	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx, `UPDATE subscriber_pii_scan_intents SET available_at='1999-01-01'::timestamptz WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	detector := newTestDetector(t)
	worker := NewCoverageWorker(repo, detector)
	worker.LeaseTTL = 2 * time.Second
	worker.HandlerTimeout = time.Second
	worker.ReconciliationTimeout = time.Second
	worker.ReconcileTenants = 10
	worker.ReconcileBatch = 20
	worker.ClaimBatch = 20
	if _, err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state, intentStatus, errorCode string
	var fieldsOver int
	var leaseToken *string
	if err := tx.QueryRow(ctx, `
SELECT state.state, intent.status, intent.last_error_code,
       state.fields_over_limit, intent.lease_token::text
  FROM subscriber_pii_scan_states state
  JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=state.tenant_id AND intent.subscriber_id=state.subscriber_id
	 WHERE state.tenant_id=$1::uuid AND state.subscriber_id=$2::uuid`, tenantID, subscriberID).
		Scan(&state, &intentStatus, &errorCode, &fieldsOver, &leaseToken); err != nil {
		t.Fatal(err)
	}
	if state != "truncated" || intentStatus != "dead_letter" || errorCode != "scan_truncated" || fieldsOver != wantFieldsOver || leaseToken != nil {
		t.Fatalf("truncation state=%s intent=%s code=%s fields_over=%d want=%d token=%v", state, intentStatus, errorCode, fieldsOver, wantFieldsOver, leaseToken)
	}
}

func TestCoveragePipeline_LeaseLossIsTyped(t *testing.T) {
	if !errors.Is(ErrLeaseLost, ErrLeaseLost) {
		t.Fatal("typed lease error regression")
	}
}

func TestCoveragePipeline_RejectsNonCurrentDetectionProvenance(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	subscriberID := seedSubscriber(t, pool, tenantID, fmt.Sprintf("provenance-%s@example.test", uuid.NewString()))
	detection := detectionFixture(t, tenantID, "private_notes", TypeSSN, 0.9, "123-45-6789")
	detection.PolicyVersion = "stale-policy"
	repo := &Repo{Pool: pool}
	inserted, err := repo.RecordDetections(ctx, tenantID, subscriberID, []Detection{detection})
	if inserted != 0 || !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("stale provenance insert=(%d,%v)", inserted, err)
	}
	page, err := repo.ListFindingsForSubscriber(ctx, tenantID, subscriberID, FindingFilter{})
	if err != nil || page.Total != 0 {
		t.Fatalf("stale provenance persisted page=%+v err=%v", page, err)
	}
}

func TestCoveragePipeline_ProvenanceContractRotationReconcilesOnce(t *testing.T) {
	pool := newTestPool(t)
	requireCoverageMigration(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	enabled := true
	if _, err := repo.UpsertScanConfig(ctx, tenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	subscriberID := insertCoverageSubscriber(t, pool, tenantID, "rotation 123-45-6789")

	newWorker := func(detector *Detector) *CoverageWorker {
		worker := NewCoverageWorker(repo, detector)
		worker.LeaseTTL = 2 * time.Second
		worker.HandlerTimeout = time.Second
		worker.ReconciliationTimeout = time.Second
		worker.ClaimBatch = 100
		worker.ReconcileBatch = 100
		worker.ReconcileTenants = 20
		return worker
	}
	detectorV1, err := NewDetector([]byte("coverage-contract-v1-pepper-at-least-32-bytes"), "contract-v1")
	if err != nil {
		t.Fatal(err)
	}
	workerV1 := newWorker(detectorV1)
	var generationV1, scannedGeneration int64
	var keyVersion, persistedContract string
	for tick := 0; tick < 30; tick++ {
		if _, err := workerV1.Tick(ctx); err != nil {
			t.Fatalf("v1 tick %d: %v", tick, err)
		}
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		err = tx.QueryRow(ctx, `
SELECT coverage.generation, coverage.scan_contract,
       state.scanned_generation, COALESCE(state.fingerprint_key_version, '')
  FROM tenant_pii_scan_coverage coverage
  JOIN subscriber_pii_scan_states state
    ON state.tenant_id=coverage.tenant_id AND state.subscriber_id=$2::uuid
 WHERE coverage.tenant_id=$1::uuid`, tenantID, subscriberID).
			Scan(&generationV1, &persistedContract, &scannedGeneration, &keyVersion)
		_ = tx.Rollback(ctx)
		if err == nil && scannedGeneration == generationV1 && keyVersion == "contract-v1" {
			cfg, cfgErr := repo.GetScanConfig(ctx, tenantID)
			if cfgErr == nil && cfg.CoverageEvidence != nil && cfg.CoverageEvidence.SnapshotExact {
				break
			}
		}
	}
	wantContractV1, ok := currentCoverageScanContract(detectorV1)
	if !ok || persistedContract != wantContractV1 || keyVersion != "contract-v1" || scannedGeneration != generationV1 {
		t.Fatalf("v1 generation=%d scanned=%d key=%q contract=%q want=%q", generationV1, scannedGeneration, keyVersion, persistedContract, wantContractV1)
	}

	detectorV2, err := NewDetector([]byte("coverage-contract-v2-pepper-at-least-32-bytes"), "contract-v2")
	if err != nil {
		t.Fatal(err)
	}
	workerV2 := newWorker(detectorV2)
	var generationV2 int64
	for tick := 0; tick < 30; tick++ {
		if _, err := workerV2.Tick(ctx); err != nil {
			t.Fatalf("v2 tick %d: %v", tick, err)
		}
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		err = tx.QueryRow(ctx, `
SELECT coverage.generation, coverage.scan_contract,
       state.scanned_generation, COALESCE(state.fingerprint_key_version, '')
  FROM tenant_pii_scan_coverage coverage
  JOIN subscriber_pii_scan_states state
    ON state.tenant_id=coverage.tenant_id AND state.subscriber_id=$2::uuid
 WHERE coverage.tenant_id=$1::uuid`, tenantID, subscriberID).
			Scan(&generationV2, &persistedContract, &scannedGeneration, &keyVersion)
		_ = tx.Rollback(ctx)
		if err == nil && generationV2 == generationV1+1 && scannedGeneration == generationV2 && keyVersion == "contract-v2" {
			cfg, cfgErr := repo.GetScanConfig(ctx, tenantID)
			if cfgErr == nil && cfg.CoverageEvidence != nil && cfg.CoverageEvidence.SnapshotExact {
				break
			}
		}
	}
	wantContractV2, ok := currentCoverageScanContract(detectorV2)
	if !ok || generationV2 != generationV1+1 || scannedGeneration != generationV2 ||
		keyVersion != "contract-v2" || persistedContract != wantContractV2 {
		t.Fatalf("v2 generation=%d want=%d scanned=%d key=%q contract=%q want_contract=%q",
			generationV2, generationV1+1, scannedGeneration, keyVersion, persistedContract, wantContractV2)
	}
	if _, err := workerV2.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	stableTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var stableGeneration int64
	if err := stableTx.QueryRow(ctx, `SELECT generation FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`, tenantID).Scan(&stableGeneration); err != nil {
		_ = stableTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = stableTx.Rollback(ctx)
	if stableGeneration != generationV2 {
		t.Fatalf("unchanged provenance advanced generation %d -> %d", generationV2, stableGeneration)
	}
	activationResults := make(chan error, 8)
	for replica := 0; replica < cap(activationResults); replica++ {
		go func() {
			accepted, activateErr := repo.activateScannerContract(ctx, true, wantContractV2)
			if activateErr == nil && !accepted {
				activateErr = errors.New("current contract was fenced")
			}
			activationResults <- activateErr
		}()
	}
	for replica := 0; replica < cap(activationResults); replica++ {
		if activateErr := <-activationResults; activateErr != nil {
			t.Fatalf("concurrent current-contract activation %d: %v", replica, activateErr)
		}
	}
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT generation FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &stableGeneration)
	if stableGeneration != generationV2 {
		t.Fatalf("concurrent steady activation advanced generation %d -> %d", generationV2, stableGeneration)
	}

	// Exact coverage must include the fingerprint identity, not only the scanner
	// and detector versions. A forged/stale key watermark at the current
	// generation is rediscovered and rescanned before exactness returns.
	if affected := mustTenantExec(t, ctx, pool, tenantID, `
UPDATE subscriber_pii_scan_states
   SET fingerprint_key_version='contract-v1'
	 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); affected != 1 {
		t.Fatalf("forged fingerprint watermark affected %d rows", affected)
	}
	if affected := mustTenantExec(t, ctx, pool, tenantID, `
UPDATE tenant_pii_scan_coverage
   SET status='backfill_pending', snapshot_exact=false,
       reconciliation_requested_at=now()
	 WHERE tenant_id=$1::uuid`, tenantID); affected != 1 {
		t.Fatalf("fingerprint repair request affected %d rows", affected)
	}
	for tick := 0; tick < 30; tick++ {
		if _, err := workerV2.Tick(ctx); err != nil {
			t.Fatalf("fingerprint repair tick %d: %v", tick, err)
		}
		var repairedKey string
		var exact bool
		mustTenantScan(t, ctx, pool, tenantID, `
SELECT state.fingerprint_key_version, coverage.snapshot_exact
  FROM subscriber_pii_scan_states state
  JOIN tenant_pii_scan_coverage coverage ON coverage.tenant_id=state.tenant_id
 WHERE state.tenant_id=$1::uuid AND state.subscriber_id=$2::uuid`,
			[]any{tenantID, subscriberID}, &repairedKey, &exact)
		if repairedKey == "contract-v2" && exact {
			break
		}
		if tick == 29 {
			t.Fatalf("fingerprint identity was not repaired key=%q exact=%t", repairedKey, exact)
		}
	}

	// Reusing a key version with different key material is configuration drift,
	// not a legitimate new provenance contract. The commitment fence rejects it
	// without advancing tenant generation or taking over the active contract.
	driftedDetector, err := NewDetector([]byte("coverage-contract-v2-different-key-material-32bytes"), "contract-v2")
	if err != nil {
		t.Fatal(err)
	}
	driftedContract, ok := currentCoverageScanContract(driftedDetector)
	if !ok || driftedContract == wantContractV2 {
		t.Fatal("same-version key drift did not produce a distinct attestation")
	}
	driftedWorker := newWorker(driftedDetector)
	if work, err := driftedWorker.Tick(ctx); err != nil || work != 0 {
		t.Fatalf("same-version key drift work=%d err=%v", work, err)
	}
	var postDriftContract string
	var postDriftGeneration int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT scan_contract, generation FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &postDriftContract, &postDriftGeneration)
	if postDriftContract != wantContractV2 || postDriftGeneration != generationV2 {
		t.Fatalf("same-version key drift took over contract=%q generation=%d", postDriftContract, postDriftGeneration)
	}

	// A tenant enabled after the deployment contract is already active binds
	// that contract in the config transaction. The next steady worker tick must
	// not require a fleet-wide mismatch sweep or advance its generation again.
	lateTenantID := uuid.NewString()
	seedTenant(t, pool, lateTenantID)
	disabled := false
	if _, err := repo.UpsertScanConfig(ctx, lateTenantID, UpdateScanConfigInput{ScanEnabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpsertScanConfig(ctx, lateTenantID, UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	var lateContract string
	var lateGeneration int64
	mustTenantScan(t, ctx, pool, lateTenantID, `
SELECT COALESCE(scan_contract, ''), generation
  FROM tenant_pii_scan_coverage
 WHERE tenant_id=$1::uuid`, []any{lateTenantID}, &lateContract, &lateGeneration)
	if lateContract != wantContractV2 || lateGeneration != 1 {
		t.Fatalf("late enable contract=%q generation=%d want_contract=%q generation=1",
			lateContract, lateGeneration, wantContractV2)
	}
	if _, err := workerV2.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var lateStableGeneration int64
	mustTenantScan(t, ctx, pool, lateTenantID,
		`SELECT generation FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{lateTenantID}, &lateStableGeneration)
	if lateStableGeneration != lateGeneration {
		t.Fatalf("steady contract advanced late tenant generation %d -> %d", lateGeneration, lateStableGeneration)
	}

	// A still-running old replica has an already-seen contract. It must be
	// fenced instead of flipping generation back during a rolling deployment,
	// and it must not claim newly queued work under stale provenance.
	fencedSubscriberID := insertCoverageSubscriber(t, pool, tenantID, "mixed replica fence")
	if staleClaims, err := repo.ClaimScanIntents(ctx, uuid.NewString(), time.Minute, 100, wantContractV1); err != nil || len(staleClaims) != 0 {
		t.Fatalf("stale contract direct intent claims=%d err=%v", len(staleClaims), err)
	}
	if staleReconciliations, err := repo.ClaimReconciliations(ctx, uuid.NewString(), time.Minute, 20, wantContractV1); err != nil || len(staleReconciliations) != 0 {
		t.Fatalf("stale contract direct reconciliation claims=%d err=%v", len(staleReconciliations), err)
	}
	work, err := workerV1.Tick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if work != 0 {
		t.Fatalf("stale-contract worker processed %d queue items", work)
	}
	var fencedGeneration int64
	var fencedContract, fencedStatus string
	var fencedAttempts int
	var contractHistory []string
	mustWorkerScan(t, ctx, pool, `
SELECT coverage.generation, coverage.scan_contract, runtime.scan_contract_history,
       intent.status, intent.attempts
  FROM tenant_pii_scan_coverage coverage
  CROSS JOIN pii_scan_runtime_contract runtime
 JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id=coverage.tenant_id AND intent.subscriber_id=$2::uuid
 WHERE coverage.tenant_id=$1::uuid`, []any{tenantID, fencedSubscriberID},
		&fencedGeneration, &fencedContract, &contractHistory, &fencedStatus, &fencedAttempts)
	historyHasRotationTail := len(contractHistory) >= 2 &&
		contractHistory[len(contractHistory)-2] == wantContractV1 &&
		contractHistory[len(contractHistory)-1] == wantContractV2
	if fencedGeneration != generationV2 || fencedContract != wantContractV2 ||
		fencedStatus != "pending" || fencedAttempts != 0 || !historyHasRotationTail {
		t.Fatalf("mixed replica fence generation=%d contract=%q history=%v intent=%s attempts=%d",
			fencedGeneration, fencedContract, contractHistory, fencedStatus, fencedAttempts)
	}

	// One unhealthy replica cannot oscillate cluster state while an accepted
	// worker's heartbeat is recent. If that heartbeat genuinely expires, the
	// unhealthy replica publishes unavailable once; the active contract recovers
	// it without a steady O(tenant-count) mismatch sweep.
	unhealthyWorker := newWorker(nil)
	var beforeUnhealthyStatus string
	var beforeUnhealthyDirty int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT status, dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &beforeUnhealthyStatus, &beforeUnhealthyDirty)
	if work, err := unhealthyWorker.Tick(ctx); err != nil || work != 0 {
		t.Fatalf("recent-heartbeat unhealthy tick work=%d err=%v", work, err)
	}
	var recentHeartbeatStatus string
	var recentHeartbeatDirty int64
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT status, dirty_epoch FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &recentHeartbeatStatus, &recentHeartbeatDirty)
	if recentHeartbeatStatus == "unavailable" || recentHeartbeatDirty != beforeUnhealthyDirty {
		t.Fatalf("unhealthy replica overrode recent heartbeat status=%q->%q dirty=%d->%d",
			beforeUnhealthyStatus, recentHeartbeatStatus, beforeUnhealthyDirty, recentHeartbeatDirty)
	}
	if affected := mustWorkerExec(t, ctx, pool, `
UPDATE pii_scan_runtime_contract
   SET availability_status='available',
       last_available_at=now()-($1::bigint * interval '1 millisecond')
	WHERE singleton`, (scannerAvailabilityGrace + time.Second).Milliseconds()); affected != 1 {
		t.Fatalf("age runtime heartbeat affected %d rows", affected)
	}
	staleRuntimeConfig, err := repo.GetScanConfig(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if staleRuntimeConfig.RuntimeAvailability != "unavailable" {
		t.Fatalf("stale persisted heartbeat was exposed as %q, want unavailable",
			staleRuntimeConfig.RuntimeAvailability)
	}
	if work, err := unhealthyWorker.Tick(ctx); err != nil || work != 0 {
		t.Fatalf("expired-heartbeat unhealthy tick work=%d err=%v", work, err)
	}
	var lostStatus, runtimeAvailability string
	mustWorkerScan(t, ctx, pool, `
SELECT coverage.status, runtime.availability_status
  FROM tenant_pii_scan_coverage coverage
 CROSS JOIN pii_scan_runtime_contract runtime
 WHERE coverage.tenant_id=$1::uuid`, []any{tenantID}, &lostStatus, &runtimeAvailability)
	if lostStatus != "unavailable" || runtimeAvailability != "unavailable" {
		t.Fatalf("expired active heartbeat status=%q runtime=%q", lostStatus, runtimeAvailability)
	}
	if _, err := workerV2.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	mustWorkerScan(t, ctx, pool, `
SELECT coverage.status, runtime.availability_status
  FROM tenant_pii_scan_coverage coverage
 CROSS JOIN pii_scan_runtime_contract runtime
 WHERE coverage.tenant_id=$1::uuid`, []any{tenantID}, &lostStatus, &runtimeAvailability)
	if lostStatus == "unavailable" || runtimeAvailability != "available" {
		t.Fatalf("active contract did not recover status=%q runtime=%q", lostStatus, runtimeAvailability)
	}

	// Run owns an independent deployment heartbeat rather than waiting for a
	// potentially 60-90 second Tick to return. Exercise that loop at a short test
	// interval after aging only the runtime row; it must restore the public
	// availability view without advancing a tenant generation.
	if affected := mustWorkerExec(t, ctx, pool, `
UPDATE pii_scan_runtime_contract
   SET availability_status='available',
       last_available_at=now()-($1::bigint * interval '1 millisecond')
	WHERE singleton`, (scannerAvailabilityGrace + time.Second).Milliseconds()); affected != 1 {
		t.Fatalf("re-age runtime heartbeat affected %d rows", affected)
	}
	workerV2.runtimeHeartbeatInterval = 10 * time.Millisecond
	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	heartbeatDone := make(chan struct{})
	go workerV2.runtimeAvailabilityHeartbeat(heartbeatCtx, heartbeatDone)
	heartbeatRecovered := false
	for attempt := 0; attempt < 200; attempt++ {
		cfg, cfgErr := repo.GetScanConfig(ctx, tenantID)
		if cfgErr != nil {
			stopHeartbeat()
			<-heartbeatDone
			t.Fatal(cfgErr)
		}
		if cfg.RuntimeAvailability == "available" {
			heartbeatRecovered = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stopHeartbeat()
	<-heartbeatDone
	if !heartbeatRecovered {
		t.Fatal("independent runtime heartbeat did not restore truthful availability")
	}
	mustTenantScan(t, ctx, pool, tenantID,
		`SELECT generation FROM tenant_pii_scan_coverage WHERE tenant_id=$1::uuid`,
		[]any{tenantID}, &stableGeneration)
	if stableGeneration != generationV2 {
		t.Fatalf("runtime heartbeat advanced generation %d -> %d", generationV2, stableGeneration)
	}

	// Contract history is a deliberate 32-transition overlap window, not an
	// unbounded rollback ledger. Contract #33 must remain deployable while the
	// oldest contract falls out of the supported mixed-replica window.
	lastHistoryContract := wantContractV2
	for transition := 0; transition < 31; transition++ {
		keyVersion := fmt.Sprintf("history-%02d", transition)
		pepper := []byte(fmt.Sprintf("coverage-history-%02d-pepper-material-at-least-32-bytes", transition))
		historyDetector, detectorErr := NewDetector(pepper, keyVersion)
		if detectorErr != nil {
			t.Fatal(detectorErr)
		}
		contract, contractOK := currentCoverageScanContract(historyDetector)
		if !contractOK {
			t.Fatalf("history transition %d produced no contract", transition)
		}
		accepted, activateErr := repo.activateScannerContract(ctx, true, contract)
		if activateErr != nil || !accepted {
			t.Fatalf("history transition %d accepted=%t err=%v", transition, accepted, activateErr)
		}
		lastHistoryContract = contract
	}
	var boundedHistory []string
	var activeHistoryContract string
	mustWorkerScan(t, ctx, pool, `
SELECT scan_contract, scan_contract_history
  FROM pii_scan_runtime_contract
 WHERE singleton`, nil, &activeHistoryContract, &boundedHistory)
	if len(boundedHistory) != maxCoverageScanContracts ||
		boundedHistory[0] != wantContractV2 ||
		boundedHistory[len(boundedHistory)-1] != lastHistoryContract ||
		activeHistoryContract != lastHistoryContract {
		t.Fatalf("bounded history len=%d first=%q last=%q active=%q",
			len(boundedHistory), boundedHistory[0], boundedHistory[len(boundedHistory)-1], activeHistoryContract)
	}
}
