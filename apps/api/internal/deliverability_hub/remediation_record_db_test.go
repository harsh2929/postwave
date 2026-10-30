// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// An automatic cap has to leave a record.
//
// The worker installs a repair override after a sustained low score and lifts
// it after a sustained recovery, both with no human involved. Nothing was
// written down: an operator saw their sending rate halve and later un-halve,
// and the only trace was a `deliverability_repair_overrides` row the release
// then cleared. "When were we capped, why, and when did it lift" was
// unanswerable after the fact — during exactly the incident the cap exists for.

func readRemediation(t *testing.T, pool *db.Pool, ctx context.Context) (applied bool, releasedAt *time.Time, appliedScore int, snapshotID int64) {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, throttleTestTenantID); err != nil {
		t.Fatalf("bind tenant: %v", err)
	}
	row := tx.QueryRow(ctx, `
SELECT released_at, applied_score, applied_snapshot_id
  FROM deliverability_remediations
 WHERE tenant_id = $1::uuid
 ORDER BY applied_at DESC
 LIMIT 1`, throttleTestTenantID)
	if err := row.Scan(&releasedAt, &appliedScore, &snapshotID); err != nil {
		return false, nil, 0, 0
	}
	return true, releasedAt, appliedScore, snapshotID
}

func readRemediationRelease(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
) (kind *string, snapshotID *int64, score *int, overrideID int64) {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, throttleTestTenantID); err != nil {
		t.Fatalf("bind tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT release_kind, released_snapshot_id, released_score, override_id
  FROM deliverability_remediations
 WHERE tenant_id = $1::uuid
 ORDER BY applied_at DESC
 LIMIT 1`, throttleTestTenantID).Scan(&kind, &snapshotID, &score, &overrideID); err != nil {
		t.Fatalf("read remediation release: %v", err)
	}
	return kind, snapshotID, score, overrideID
}

func seedSnapshot(t *testing.T, pool *db.Pool, ctx context.Context, score int, at time.Time) int64 {
	return seedSnapshotEvidence(t, pool, ctx, score, true, DeliverabilityScoreModelVersion, at)
}

func seedSnapshotEvidence(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	score int,
	qualified bool,
	modelVersion string,
	at time.Time,
) int64 {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, throttleTestTenantID); err != nil {
		t.Fatalf("bind tenant: %v", err)
	}
	sampleSize := int64(0)
	if qualified {
		sampleSize = 10000
	}
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO deliverability_hub_snapshots
    (tenant_id, score, model_version, sample_qualified, sample_size, sampled_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
RETURNING id`, throttleTestTenantID, score, modelVersion, qualified, sampleSize, at).Scan(&id); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit snapshot: %v", err)
	}
	return id
}

func seedForeignSnapshot(t *testing.T, pool *db.Pool, ctx context.Context, score int, at time.Time) int64 {
	t.Helper()
	const foreignTenantID = "00000000-0000-4000-8000-187300000099"
	// Seed the foreign evidence through that tenant's own worker scope. A
	// cross-tenant worker transaction deliberately cannot insert a tenant row
	// under the production RLS policy, and the test must not rely on bypassing
	// that boundary merely to construct mismatched evidence.
	tx, err := db.WithTenantWorker(ctx, pool, foreignTenantID)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'remediation-foreign-test', 'remediation-foreign-test', 'studio')
ON CONFLICT (id) DO NOTHING`, foreignTenantID); err != nil {
		t.Fatalf("seed foreign tenant: %v", err)
	}
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO deliverability_hub_snapshots
    (tenant_id, score, model_version, sample_qualified, sample_size, sampled_at)
VALUES ($1::uuid, $2, $3, true, 10000, $4)
RETURNING id`, foreignTenantID, score, DeliverabilityScoreModelVersion, at).Scan(&id); err != nil {
		t.Fatalf("seed foreign snapshot: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit foreign snapshot: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanup, cleanupErr := db.WithTenantWorker(cleanupCtx, pool, foreignTenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, foreignTenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return id
}

func TestAnAutomaticThrottleRecordsWhyItApplied(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, ctx, 40, observedAt)

	w := &Worker{Deps: &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}}
	result, err := w.observeAndMaybeAutoThrottle(ctx, throttleTestTenantID, 40, true, snapshotID, observedAt)
	if err != nil {
		t.Fatalf("observe: %v", err)
	}
	if !result.Applied {
		t.Fatalf("no throttle applied; fixture is not eligible: %+v", result)
	}

	found, releasedAt, score, recordedSnapshot := readRemediation(t, pool, ctx)
	if !found {
		t.Fatal("the cap was installed with no remediation row — nothing records " +
			"that this tenant was throttled, or why")
	}
	if releasedAt != nil {
		t.Fatalf("released_at=%v on a cap that was just applied", releasedAt)
	}
	if score != 40 {
		t.Fatalf("applied_score=%d, want the score that triggered it", score)
	}
	if recordedSnapshot != snapshotID {
		t.Fatalf("applied_snapshot_id=%d, want %d — the justification must point "+
			"at the observation that crossed the threshold, not a copy of it",
			recordedSnapshot, snapshotID)
	}
}

func TestAutomaticThrottleRejectsNonCanonicalSnapshotEvidence(t *testing.T) {
	for _, test := range []struct {
		name     string
		snapshot func(*testing.T, *db.Pool, context.Context, time.Time) int64
	}{
		{
			name: "foreign tenant",
			snapshot: func(t *testing.T, pool *db.Pool, ctx context.Context, at time.Time) int64 {
				return seedForeignSnapshot(t, pool, ctx, 40, at)
			},
		},
		{
			name: "score mismatch",
			snapshot: func(t *testing.T, pool *db.Pool, ctx context.Context, at time.Time) int64 {
				return seedSnapshot(t, pool, ctx, 41, at)
			},
		},
		{
			name: "unqualified snapshot",
			snapshot: func(t *testing.T, pool *db.Pool, ctx context.Context, at time.Time) int64 {
				return seedSnapshotEvidence(
					t, pool, ctx, 40, false, DeliverabilityScoreModelVersion, at,
				)
			},
		},
		{
			name: "wrong model",
			snapshot: func(t *testing.T, pool *db.Pool, ctx context.Context, at time.Time) int64 {
				return seedSnapshotEvidence(t, pool, ctx, 40, true, "superseded-test-model", at)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := newThrottleDBTestPool(t)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			observedAt := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
			seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
			snapshotID := test.snapshot(t, pool, ctx, observedAt)
			worker := &Worker{Deps: &Deps{Pool: pool, HubInterval: time.Hour,
				Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}}
			if result, err := worker.observeAndMaybeAutoThrottle(
				ctx, throttleTestTenantID, 40, true, snapshotID, observedAt,
			); err == nil || result.Applied {
				t.Fatalf("mismatched evidence result=%+v err=%v", result, err)
			}

			verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
			if err != nil {
				t.Fatalf("begin mismatch verification: %v", err)
			}
			defer func() { _ = verify.Rollback(ctx) }()
			var capValue, active, episodes int
			if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides WHERE tenant_id=$1::uuid AND cleared_at IS NULL),
       (SELECT count(*) FROM deliverability_remediations WHERE tenant_id=$1::uuid)`,
				throttleTestTenantID).Scan(&capValue, &active, &episodes); err != nil {
				t.Fatalf("verify mismatch rollback: %v", err)
			}
			if capValue != 8000 || active != 0 || episodes != 0 {
				t.Fatalf("mismatch rollback cap=%d active=%d episodes=%d, want 8000/0/0",
					capValue, active, episodes)
			}
		})
	}
}

func TestApplyRollbackReleasesOnlyPoolConnectionBeforeFenceAbort(t *testing.T) {
	pool := newThrottleDBTestPoolWithMaxConns(t, 1)
	if got := pool.Stat().MaxConns(); got != 1 {
		t.Fatalf("test pool max conns=%d, want 1", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	// The caller claims score 40 while the named canonical snapshot stores 41,
	// forcing a post-fence/pre-commit error and deferred fence abort.
	snapshotID := seedSnapshot(t, pool, ctx, 41, observedAt)
	abortCalls := 0
	var abortReentryErr error
	worker := &Worker{Deps: &Deps{
		Pool:        pool,
		HubInterval: time.Hour,
		Clock:       func() time.Time { return observedAt },
		CapCoordinator: throttleTestCapCoordinator{
			abortCall:       &abortCalls,
			abortPool:       pool,
			abortReentryErr: &abortReentryErr,
		},
	}}

	result, err := worker.observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, snapshotID, observedAt,
	)
	if err == nil || result.Applied {
		t.Fatalf("mismatched evidence result=%+v err=%v, want rollback", result, err)
	}
	if abortCalls != 1 {
		t.Fatalf("abort calls=%d, want 1", abortCalls)
	}
	if abortReentryErr != nil {
		t.Fatalf("abort could not re-enter max-one pool after rollback: %v", abortReentryErr)
	}
}

func TestClearRollbackReleasesOnlyPoolConnectionBeforeFenceAbort(t *testing.T) {
	pool := newThrottleDBTestPoolWithMaxConns(t, 1)
	if got := pool.Stat().MaxConns(); got != 1 {
		t.Fatalf("test pool max conns=%d, want 1", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	snapshotID := seedSnapshot(t, pool, ctx, 40, observedAt)
	deps := &Deps{
		Pool:           pool,
		HubInterval:    time.Hour,
		Clock:          func() time.Time { return observedAt },
		CapCoordinator: throttleTestCapCoordinator{},
	}
	applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, snapshotID, observedAt,
	)
	if err != nil || !applied.Applied {
		t.Fatalf("apply result=%+v err=%v", applied, err)
	}

	abortCalls := 0
	var abortReentryErr error
	deps.CapCoordinator = throttleTestCapCoordinator{
		abortCall:       &abortCalls,
		abortPool:       pool,
		abortReentryErr: &abortReentryErr,
	}
	// The invalid UUID is consumed by the settings UPDATE only after the cap
	// fence opens, forcing the clear transaction down its deferred abort path.
	invalidUserID := "not-a-uuid"
	result, err := deps.clearOverride(
		ctx,
		throttleTestTenantID,
		"operator",
		db.AuditMeta{
			TenantID: throttleTestTenantID,
			UserID:   &invalidUserID,
		},
	)
	if err == nil || result.Cleared {
		t.Fatalf("invalid-attribution clear result=%+v err=%v, want rollback", result, err)
	}
	if abortCalls != 1 {
		t.Fatalf("abort calls=%d, want 1", abortCalls)
	}
	if abortReentryErr != nil {
		t.Fatalf("abort could not re-enter max-one pool after rollback: %v", abortReentryErr)
	}
}

func TestClearRejectsActiveOverrideWithoutExactOpenRemediation_DB(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	legacy, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin missing-episode fixture: %v", err)
	}
	var overrideID int64
	if err := legacy.QueryRow(ctx, `
INSERT INTO deliverability_repair_overrides
    (tenant_id, prior_max_sends_per_hour, throttled_max_sends_per_hour, reason)
VALUES ($1::uuid, 16000, 8000, 'legacy override without remediation')
RETURNING id`, throttleTestTenantID).Scan(&overrideID); err != nil {
		_ = legacy.Rollback(ctx)
		t.Fatalf("seed active override without remediation: %v", err)
	}
	if err := legacy.Commit(ctx); err != nil {
		t.Fatalf("commit missing-episode fixture: %v", err)
	}

	deps := &Deps{
		Pool:           pool,
		Clock:          func() time.Time { return observedAt },
		CapCoordinator: throttleTestCapCoordinator{},
	}
	result, err := deps.clearOverride(
		ctx,
		throttleTestTenantID,
		"operator",
		automaticThrottleAuditMeta(throttleTestTenantID),
	)
	if !errors.Is(err, ErrThrottleRemediationEpisodeMismatch) || result.Cleared {
		t.Fatalf("missing-episode clear result=%+v err=%v, want mismatch/no clear", result, err)
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin missing-episode verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var capValue, active int
	if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND id=$2 AND cleared_at IS NULL)`,
		throttleTestTenantID, overrideID).Scan(&capValue, &active); err != nil {
		t.Fatalf("verify missing-episode rejection: %v", err)
	}
	if capValue != 8000 || active != 1 {
		t.Fatalf("missing-episode rejection cap=%d active=%d, want 8000/1", capValue, active)
	}
}

func TestTheReleaseClosesTheSameEpisode(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	w := &Worker{Deps: &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	if _, err := w.observeAndMaybeAutoThrottle(ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// Recover: a CONTINUOUS run of high scores spanning the recovery window.
	//
	// Sample spacing matters. A gap wider than the hub interval breaks
	// continuity and resets HighSince, which is the point of the rule — a tenant
	// who went quiet for two days has not demonstrated six hours of recovery. So
	// the observations here are one interval apart, and the run is long enough
	// to clear AutoThrottleRecoveryWindow.
	var released bool
	var releaseSnapshot int64
	at := observedAt
	for i := 0; i < 9; i++ {
		at = at.Add(time.Hour)
		w.Deps.Clock = func() time.Time { return at }
		snap := seedSnapshot(t, pool, ctx, 95, at)
		res, err := w.observeAndMaybeAutoThrottle(ctx, throttleTestTenantID, 95, true, snap, at)
		if err != nil {
			t.Fatalf("recovery observation %d: %v", i, err)
		}
		if res.Released {
			released = true
			releaseSnapshot = snap
			break
		}
	}
	if !released {
		t.Fatal("the throttle never released across a continuous 9-hour recovery " +
			"run past the 6-hour window")
	}

	found, releasedAt, _, _ := readRemediation(t, pool, ctx)
	if !found {
		t.Fatal("no remediation row at all")
	}
	if releasedAt == nil {
		t.Fatal("the cap lifted but the episode is still open — the record says " +
			"this tenant is capped when they are not")
	}
	kind, recordedReleaseSnapshot, releaseScore, _ := readRemediationRelease(t, pool, ctx)
	if kind == nil || *kind != remediationReleaseAutomatic ||
		recordedReleaseSnapshot == nil || *recordedReleaseSnapshot != releaseSnapshot ||
		releaseScore == nil || *releaseScore != 95 {
		t.Fatalf("automatic release attribution kind=%v snapshot=%v score=%v, want %s/%d/95",
			kind, recordedReleaseSnapshot, releaseScore, remediationReleaseAutomatic, releaseSnapshot)
	}
}

func TestManualClearClosesExactEpisodeWithoutInventingEvidenceAndUnblocksNextEpisode(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	deps := &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
	worker := &Worker{Deps: deps}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	first, err := worker.observeAndMaybeAutoThrottle(ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt)
	if err != nil || !first.Applied {
		t.Fatalf("apply first episode result=%+v err=%v", first, err)
	}
	userID := throttleTestUserID
	cleared, err := deps.clearOverride(ctx, throttleTestTenantID, userID, db.AuditMeta{
		TenantID:  throttleTestTenantID,
		UserID:    &userID,
		ActorType: "human",
	})
	if err != nil || !cleared.Cleared {
		t.Fatalf("manual clear result=%+v err=%v", cleared, err)
	}
	kind, releaseSnapshot, releaseScore, recordedOverride := readRemediationRelease(t, pool, ctx)
	if kind == nil || *kind != remediationReleaseManual || releaseSnapshot != nil || releaseScore != nil ||
		recordedOverride != first.OverrideID {
		t.Fatalf("manual release kind=%v snapshot=%v score=%v override=%d, want manual/nil/nil/%d",
			kind, releaseSnapshot, releaseScore, recordedOverride, first.OverrideID)
	}

	// Make the next observation independently eligible. The prior episode's
	// exact row must no longer occupy the partial-unique open slot.
	nextAt := observedAt.Add(48 * time.Hour)
	stateTx, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin second episode state: %v", err)
	}
	if _, err := stateTx.Exec(ctx, `
UPDATE deliverability_throttle_state
   SET low_since = $2,
       high_since = NULL,
       last_sampled_at = $3,
       last_score = 40,
       sample_qualified = true,
       updated_at = $3
 WHERE tenant_id = $1::uuid`, throttleTestTenantID, nextAt.Add(-24*time.Hour), nextAt.Add(-time.Hour)); err != nil {
		_ = stateTx.Rollback(ctx)
		t.Fatalf("seed second episode state: %v", err)
	}
	if err := stateTx.Commit(ctx); err != nil {
		t.Fatalf("commit second episode state: %v", err)
	}
	deps.Clock = func() time.Time { return nextAt }
	secondSnapshot := seedSnapshot(t, pool, ctx, 40, nextAt)
	second, err := worker.observeAndMaybeAutoThrottle(ctx, throttleTestTenantID, 40, true, secondSnapshot, nextAt)
	if err != nil || !second.Applied || second.OverrideID == first.OverrideID {
		t.Fatalf("apply second episode result=%+v err=%v", second, err)
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin episode count: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var total, open int
	if err := verify.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE released_at IS NULL)
  FROM deliverability_remediations
 WHERE tenant_id = $1::uuid`, throttleTestTenantID).Scan(&total, &open); err != nil {
		t.Fatalf("count episodes: %v", err)
	}
	if total != 2 || open != 1 {
		t.Fatalf("episode counts total=%d open=%d, want 2/1", total, open)
	}
}

func TestClearRollbackLeavesOverrideCapAndExactEpisodeOpen(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	deps := &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt,
	)
	if err != nil || !applied.Applied {
		t.Fatalf("apply result=%+v err=%v", applied, err)
	}
	deps.commitCapMutationTx = rollbackThrottleTxThenFail
	if _, err := deps.clearOverride(
		ctx, throttleTestTenantID, "operator", automaticThrottleAuditMeta(throttleTestTenantID),
	); err == nil || !errors.Is(err, errThrottleTestCommitReplyLost) {
		t.Fatalf("rollback clear error=%v", err)
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin rollback verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var capValue, activeOverride, openEpisode int
	if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND id=$2 AND cleared_at IS NULL),
       (SELECT count(*) FROM deliverability_remediations
         WHERE tenant_id=$1::uuid AND override_id=$2 AND released_at IS NULL)`,
		throttleTestTenantID, applied.OverrideID).Scan(&capValue, &activeOverride, &openEpisode); err != nil {
		t.Fatalf("verify rollback: %v", err)
	}
	if capValue != 4000 || activeOverride != 1 || openEpisode != 1 {
		t.Fatalf("rollback cap=%d active=%d open_episode=%d, want 4000/1/1",
			capValue, activeOverride, openEpisode)
	}
}

func TestAutomaticReleaseClosesExactEpisodeEvenWhenRedisConvergenceIsPending(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	deps := &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt,
	)
	if err != nil || !applied.Applied {
		t.Fatalf("apply result=%+v err=%v", applied, err)
	}
	releasedAt := observedAt.Add(7 * time.Hour)
	releaseSnapshot := seedSnapshot(t, pool, ctx, 95, releasedAt)
	recoveryState, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin recovery state: %v", err)
	}
	if _, err := recoveryState.Exec(ctx, `
UPDATE deliverability_throttle_state
   SET high_since=$2, low_since=NULL, last_sampled_at=$3,
       last_score=95, sample_qualified=true, updated_at=$3
 WHERE tenant_id=$1::uuid`, throttleTestTenantID,
		releasedAt.Add(-AutoThrottleRecoveryWindow), releasedAt); err != nil {
		_ = recoveryState.Rollback(ctx)
		t.Fatalf("seed recovery state: %v", err)
	}
	if err := recoveryState.Commit(ctx); err != nil {
		t.Fatalf("commit recovery state: %v", err)
	}
	deps.Clock = func() time.Time { return releasedAt }
	deps.CapCoordinator = throttleTestCapCoordinator{commitErr: sending.ErrCapCoordinationUnavailable}
	result, err := deps.clearOverrideWithRelease(
		ctx,
		throttleTestTenantID,
		"auto: reputation_recovered",
		automaticThrottleAuditMeta(throttleTestTenantID),
		&throttleReleaseEvidence{SnapshotID: releaseSnapshot, Score: 95},
	)
	if err != nil || !result.Cleared || !result.CapConvergencePending {
		t.Fatalf("automatic pending release result=%+v err=%v", result, err)
	}
	kind, recordedSnapshot, recordedScore, recordedOverride := readRemediationRelease(t, pool, ctx)
	if kind == nil || *kind != remediationReleaseAutomatic ||
		recordedSnapshot == nil || *recordedSnapshot != releaseSnapshot ||
		recordedScore == nil || *recordedScore != 95 || recordedOverride != applied.OverrideID {
		t.Fatalf("pending release kind=%v snapshot=%v score=%v override=%d, want %s/%d/95/%d",
			kind, recordedSnapshot, recordedScore, recordedOverride,
			remediationReleaseAutomatic, releaseSnapshot, applied.OverrideID)
	}
}

func TestAutomaticReleaseRejectsEvidenceSupersededByNewerObservation(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))

	deps := &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt,
	)
	if err != nil || !applied.Applied {
		t.Fatalf("apply result=%+v err=%v", applied, err)
	}

	releaseAt := observedAt.Add(7 * time.Hour)
	staleReleaseSnapshot := seedSnapshot(t, pool, ctx, 95, releaseAt)
	newerAt := releaseAt.Add(time.Hour)
	_ = seedSnapshot(t, pool, ctx, 40, newerAt)
	newerState, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin newer observation state: %v", err)
	}
	if _, err := newerState.Exec(ctx, `
UPDATE deliverability_throttle_state
   SET high_since=NULL, low_since=$2, last_sampled_at=$2,
       last_score=40, sample_qualified=true, updated_at=$2
 WHERE tenant_id=$1::uuid`, throttleTestTenantID, newerAt); err != nil {
		_ = newerState.Rollback(ctx)
		t.Fatalf("seed newer low observation: %v", err)
	}
	if err := newerState.Commit(ctx); err != nil {
		t.Fatalf("commit newer low observation: %v", err)
	}

	result, err := deps.clearOverrideWithRelease(
		ctx,
		throttleTestTenantID,
		"auto: reputation_recovered",
		automaticThrottleAuditMeta(throttleTestTenantID),
		&throttleReleaseEvidence{SnapshotID: staleReleaseSnapshot, Score: 95},
	)
	if !errors.Is(err, ErrThrottleReleaseEvidenceChanged) || result.Cleared {
		t.Fatalf("stale release result=%+v err=%v, want evidence-changed/no clear", result, err)
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin stale release verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var capValue, activeOverride, openEpisode int
	if err := verify.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_repair_overrides
         WHERE tenant_id=$1::uuid AND id=$2 AND cleared_at IS NULL),
       (SELECT count(*) FROM deliverability_remediations
         WHERE tenant_id=$1::uuid AND override_id=$2 AND released_at IS NULL)`,
		throttleTestTenantID, applied.OverrideID).Scan(&capValue, &activeOverride, &openEpisode); err != nil {
		t.Fatalf("verify stale release rejection: %v", err)
	}
	if capValue != 4000 || activeOverride != 1 || openEpisode != 1 {
		t.Fatalf("stale release cap=%d active=%d open=%d, want 4000/1/1",
			capValue, activeOverride, openEpisode)
	}
}

func TestReleaseSchemaAllowsOldAutomaticAnnotationDuringExpandPhase(t *testing.T) {
	pool := newThrottleDBTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observedAt := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)
	seedThrottleDBFixture(t, pool, observedAt.Add(-24*time.Hour), observedAt.Add(-time.Hour))
	deps := &Deps{Pool: pool, HubInterval: time.Hour,
		Clock: func() time.Time { return observedAt }, CapCoordinator: throttleTestCapCoordinator{}}
	applySnapshot := seedSnapshot(t, pool, ctx, 40, observedAt)
	applied, err := (&Worker{Deps: deps}).observeAndMaybeAutoThrottle(
		ctx, throttleTestTenantID, 40, true, applySnapshot, observedAt,
	)
	if err != nil || !applied.Applied {
		t.Fatalf("apply result=%+v err=%v", applied, err)
	}
	releasedAt := observedAt.Add(7 * time.Hour)
	releaseSnapshot := seedSnapshot(t, pool, ctx, 95, releasedAt)

	legacy, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin old-shape update: %v", err)
	}
	if _, err := legacy.Exec(ctx, `
UPDATE deliverability_repair_overrides
   SET cleared_at=$3, cleared_by='auto: reputation_recovered'
 WHERE tenant_id=$1::uuid AND id=$2`, throttleTestTenantID, applied.OverrideID, releasedAt); err != nil {
		_ = legacy.Rollback(ctx)
		t.Fatalf("old-shape clear override: %v", err)
	}
	if _, err := legacy.Exec(ctx, `
UPDATE deliverability_remediations
   SET released_snapshot_id=$3, released_at=$4, released_score=95
 WHERE tenant_id=$1::uuid AND override_id=$2 AND released_at IS NULL`,
		throttleTestTenantID, applied.OverrideID, releaseSnapshot, releasedAt); err != nil {
		_ = legacy.Rollback(ctx)
		t.Fatalf("old-shape remediation annotation was rejected during expand phase: %v", err)
	}
	if err := legacy.Commit(ctx); err != nil {
		t.Fatalf("commit old-shape automatic annotation: %v", err)
	}

	verify, err := db.WithTenant(ctx, pool, throttleTestTenantID)
	if err != nil {
		t.Fatalf("begin old-shape verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var kind *string
	if err := verify.QueryRow(ctx, `
SELECT release_kind
  FROM deliverability_remediations
 WHERE tenant_id=$1::uuid AND override_id=$2`, throttleTestTenantID, applied.OverrideID).Scan(&kind); err != nil {
		t.Fatalf("read old-shape release kind: %v", err)
	}
	if kind != nil {
		t.Fatalf("old task unexpectedly wrote new discriminator %q", *kind)
	}
}
