// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

const (
	// An uncapped tenant has no number to halve. Preserve the existing repair
	// policy of treating that state as a 5,000/hour baseline and installing a
	// 2,500/hour safety cap while retaining NULL as the value to restore.
	defaultUncappedHourlyBaseline = 5000

	// A worker delayed by one cadence should not erase 23 hours of valid
	// evidence. A gap longer than two configured cadences is no longer
	// continuous observation and starts a fresh low-score period.
	throttleObservationGapMultiplier = 2

	// All throttle apply/clear transactions take this tenant-keyed advisory
	// lock. The seed only namespaces the hash from unrelated advisory-lock users.
	throttleAdvisoryLockSeed int64 = 0x50575448524f5454 // "PWTHROTT"

	remediationReleaseAutomatic = "automatic_recovery"
	remediationReleaseManual    = "manual_clear"
)

// ErrThrottleCapDrift means a plan/admin edit changed the send cap after the
// active override installed its exact throttled value. Clearing must not
// overwrite that newer decision with the historical pre-throttle cap.
var ErrThrottleCapDrift = errors.New("deliverability throttle: sending cap changed while override was active")

// ErrThrottleReleaseEvidenceChanged means a newer Hub observation replaced
// the recovery sample while the worker moved from its observation transaction
// into the cap-clear transaction. The newer evidence wins; widening from the
// stale decision would race a low/unqualified sample that reset recovery.
var ErrThrottleReleaseEvidenceChanged = errors.New("deliverability throttle: automatic release evidence changed")

// ErrThrottleRemediationEpisodeMismatch means the active cap override and its
// one open remediation record are not a one-to-one pair. Clearing in that
// state would erase the cap without closing truthful lifecycle evidence.
var ErrThrottleRemediationEpisodeMismatch = errors.New("deliverability throttle: active override does not own exactly one open remediation episode")

// ErrThrottleCommitOutcomeUnknown means PostgreSQL returned an error from
// COMMIT and the exact transactional override receipt could not be read. The
// Redis fence remains conservative; callers must not claim applied/cleared or
// not-committed.
var ErrThrottleCommitOutcomeUnknown = errors.New("deliverability throttle: database commit outcome is unknown")

type throttleObservation struct {
	LowSince *time.Time
	// HighSince mirrors LowSince for RELEASE. Entry needs a continuous low
	// period; release needs its own continuous window at a higher bar, and the
	// band between the two thresholds accumulates neither — which is why one
	// field cannot represent both.
	HighSince       *time.Time
	LastSampledAt   time.Time
	LastScore       int
	SampleQualified bool
}

type throttleApplyResult struct {
	Applied bool
	// Released is set when this observation lifted an automatic cap. Distinct
	// from Applied so a caller can log and notify the two differently: an
	// applied throttle is a warning, a released one is good news.
	Released   bool
	OverrideID int64
	PriorCap   int
	NextCap    int
	// CapConvergencePending means the durable apply/release committed while
	// Redis could not confirm the canonical ready state. Admissions remain on
	// the conservative fence, but callers must still complete the durable
	// post-commit lifecycle (logging and notification). Remediation closure is
	// already atomic with the database cap release.
	CapConvergencePending bool
}

type throttleClearResult struct {
	Cleared               bool
	CapConvergencePending bool
}

// throttleReleaseEvidence binds an automatic release to the exact Hub
// observation that crossed the sustained recovery threshold. A nil value is a
// manual administrative clear and intentionally carries no fabricated score
// or snapshot attribution.
type throttleReleaseEvidence struct {
	SnapshotID int64
	Score      int
}

// advanceThrottleObservation is the pure state transition behind the durable
// throttle state row. accepted=false means a stale observation was ignored.
func advanceThrottleObservation(
	previous throttleObservation,
	score int,
	qualified bool,
	sampledAt time.Time,
	maxGap time.Duration,
) (next throttleObservation, accepted bool) {
	if !previous.LastSampledAt.IsZero() && sampledAt.Before(previous.LastSampledAt) {
		return previous, false
	}

	next = throttleObservation{
		LastSampledAt:   sampledAt,
		LastScore:       score,
		SampleQualified: qualified,
	}

	// The HIGH period, tracked symmetrically with the low one below.
	//
	// Only a qualified sample at or above the recovery bar extends it; anything
	// else — a low sample, a sample inside the hysteresis band, or an
	// unqualified one — resets it to nil by leaving the field unset. The band
	// between the entry and recovery thresholds deliberately accumulates
	// neither: a tenant there is not recovering, and is not newly failing.
	continuityBrokenForHigh := previous.LastSampledAt.IsZero() ||
		(maxGap > 0 && sampledAt.Sub(previous.LastSampledAt) > maxGap)
	if qualified && score >= AutoThrottleRecoveryThreshold {
		if previous.HighSince == nil || continuityBrokenForHigh {
			started := sampledAt
			next.HighSince = &started
		} else {
			started := previous.HighSince.UTC()
			next.HighSince = &started
		}
	}

	if !qualified || score >= AutoThrottleScoreThreshold {
		return next, true
	}

	continuityBroken := previous.LastSampledAt.IsZero() ||
		(maxGap > 0 && sampledAt.Sub(previous.LastSampledAt) > maxGap)
	if previous.LowSince == nil ||
		previous.LastScore >= AutoThrottleScoreThreshold ||
		continuityBroken {
		started := sampledAt
		next.LowSince = &started
		return next, true
	}

	started := previous.LowSince.UTC()
	next.LowSince = &started
	return next, true
}

func throttleObservationEligible(observation throttleObservation) bool {
	return observation.LowSince != nil &&
		observation.SampleQualified &&
		observation.LastScore < AutoThrottleScoreThreshold &&
		!observation.LastSampledAt.Before(
			observation.LowSince.Add(AutoThrottleSustainWindow),
		)
}

func throttleCapStillInstalled(current *int, installed int) bool {
	return current != nil && *current == installed
}

func (w *Worker) throttleObservationMaxGap() time.Duration {
	interval := time.Hour
	if w != nil && w.Deps != nil && w.Deps.HubInterval > 0 {
		interval = w.Deps.HubInterval
	}
	return interval * throttleObservationGapMultiplier
}

func lockTenantThrottle(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
		tenantID, throttleAdvisoryLockSeed); err != nil {
		return fmt.Errorf("acquire tenant advisory lock: %w", err)
	}
	return nil
}

func automaticThrottleAuditMeta(tenantID string) db.AuditMeta {
	return db.AuditMeta{
		TenantID:   tenantID,
		ActorType:  "system",
		ActorLabel: "deliverability-auto-throttle",
	}
}

func (d *Deps) commitThrottleCapMutation(ctx context.Context, tx pgx.Tx) error {
	if d != nil && d.commitCapMutationTx != nil {
		return d.commitCapMutationTx(ctx, tx)
	}
	return tx.Commit(ctx)
}

func (d *Deps) throttleCapMutationCommitted(
	ctx context.Context,
	tenantID, token string,
) (bool, error) {
	if d != nil && d.capMutationReceipt != nil {
		return d.capMutationReceipt(ctx, tenantID, token)
	}
	if d == nil {
		return false, errors.New("deliverability throttle: cap mutation receipt lookup is unavailable")
	}
	return sending.CapMutationCommitted(ctx, d.Pool, tenantID, token)
}

// rollbackThrottleCapMutation releases the transaction-scoped cap advisory
// lock before Redis fence cleanup opens a fresh transaction to read the
// canonical cap. Calling AbortCapChange while tx still owns that lock can
// self-deadlock under pool saturation (and deterministically with MaxConns=1).
// ErrTxClosed is the normal result after COMMIT, including a lost commit ACK.
func rollbackThrottleCapMutation(ctx context.Context, tx pgx.Tx) error {
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := tx.Rollback(rollbackCtx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		return err
	}
	return nil
}

// observeAndMaybeAutoThrottle records one score observation and, when it proves
// a continuous low-score period of at least 24 hours, atomically installs the
// single active repair override and its sending cap. Every replica enters this
// method through the same tenant-keyed lock; the partial unique index remains
// the database-level final invariant.
func (w *Worker) observeAndMaybeAutoThrottle(
	ctx context.Context,
	tenantID string,
	score int,
	qualified bool,
	// snapshotID is the observation that produced `score`. Recorded on the
	// remediation row rather than copying the score, so the justification for a
	// cap cannot drift from the evidence that earned it.
	snapshotID int64,
	// sampledAt is read from that same canonical snapshot. Do not call now()
	// again here: a distinct wall-clock value would make the release transaction
	// reject every real observation when it compares state to snapshot evidence.
	sampledAt time.Time,
) (throttleApplyResult, error) {
	var result throttleApplyResult
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return result, errors.New("deliverability throttle: nil dependencies")
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return result, errors.New("deliverability throttle: tenant id is required")
	}
	if score < 0 || score > 100 {
		return result, fmt.Errorf("deliverability throttle: score %d is outside 0..100", score)
	}
	if snapshotID <= 0 {
		return result, errors.New("deliverability throttle: exact canonical snapshot evidence is required")
	}
	if sampledAt.IsZero() {
		return result, errors.New("deliverability throttle: canonical sampled_at is required")
	}

	observedAt := sampledAt.UTC()
	tx, err := db.WithTenantOptions(ctx, w.Deps.Pool, tenantID, sending.CapMutationTxOptions())
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: begin tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := lockTenantThrottle(ctx, tx, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: %w", err)
	}
	// Recovery state exists only for a cap this worker actually owns. Without
	// this gate, every continuously healthy tenant accumulates high_since and,
	// after six hours, opens a doomed clear transaction on every cadence.
	var active bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM deliverability_repair_overrides
     WHERE tenant_id = $1::uuid
       AND cleared_at IS NULL
)`, tenantID).Scan(&active); err != nil {
		return result, fmt.Errorf("deliverability throttle: inspect active override: %w", err)
	}

	// Seed a row for deployments upgraded from the former snapshot-counting
	// implementation. A first low observation starts at observedAt below; it
	// never inherits sparse historical snapshots and therefore cannot throttle
	// immediately after deployment.
	if _, err := tx.Exec(ctx, `
INSERT INTO deliverability_throttle_state
    (tenant_id, low_since, last_sampled_at, last_score, sample_qualified, updated_at)
VALUES ($1::uuid, NULL, $2, $3, $4, $2)
ON CONFLICT (tenant_id) DO NOTHING`, tenantID, observedAt, score, qualified); err != nil {
		return result, fmt.Errorf("deliverability throttle: seed observation state: %w", err)
	}

	var previous throttleObservation
	if err := tx.QueryRow(ctx, `
SELECT low_since, high_since, last_sampled_at, last_score, sample_qualified
  FROM deliverability_throttle_state
 WHERE tenant_id = $1::uuid
 FOR UPDATE`, tenantID).Scan(
		&previous.LowSince,
		&previous.HighSince,
		&previous.LastSampledAt,
		&previous.LastScore,
		&previous.SampleQualified,
	); err != nil {
		return result, fmt.Errorf("deliverability throttle: lock observation state: %w", err)
	}

	next, accepted := advanceThrottleObservation(
		previous,
		score,
		qualified,
		observedAt,
		w.throttleObservationMaxGap(),
	)
	if !active {
		next.HighSince = nil
	}
	if accepted {
		if _, err := tx.Exec(ctx, `
UPDATE deliverability_throttle_state
   SET low_since = $2,
       high_since = $6,
       last_sampled_at = $3,
       last_score = $4,
       sample_qualified = $5,
       updated_at = $3
 WHERE tenant_id = $1::uuid`,
			tenantID, next.LowSince, next.LastSampledAt, next.LastScore, next.SampleQualified,
			next.HighSince); err != nil {
			return result, fmt.Errorf("deliverability throttle: persist observation state: %w", err)
		}
	}

	// Whether this observation earns a release. Decided here, ACTED ON after the
	// commit below — clearOverride opens its own transaction and takes the same
	// advisory lock, so calling it from inside this one would deadlock against
	// itself. Reusing it unchanged is the point: the admin clear and the
	// automatic release must not become two implementations of one rule.
	releaseDue := accepted &&
		shouldReleaseThrottle(next.LastScore, next.SampleQualified, next.HighSince, observedAt)

	if !accepted || !throttleObservationEligible(next) {
		if err := tx.Commit(ctx); err != nil {
			return result, fmt.Errorf("deliverability throttle: commit observation: %w", err)
		}
		// The release lives on this branch because a recovered tenant is ALWAYS
		// here: eligibility for a new throttle requires a sustained low period,
		// and a tenant clearing the recovery bar has none. The two are mutually
		// exclusive by construction, which
		// TestReleaseAndThrottleEligibilityAreMutuallyExclusive pins so a later
		// change to either rule cannot make a recovery unreachable.
		clearResult := w.releaseIfRecovered(ctx, tenantID, releaseDue, throttleReleaseEvidence{
			SnapshotID: snapshotID,
			Score:      next.LastScore,
		})
		result.Released = clearResult.Cleared
		result.CapConvergencePending = clearResult.CapConvergencePending
		return result, nil
	}

	if active {
		if err := tx.Commit(ctx); err != nil {
			return result, fmt.Errorf("deliverability throttle: commit active observation: %w", err)
		}
		return result, nil
	}
	if err := sending.LockCapMutation(ctx, tx, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: %w", err)
	}

	// Create the settings row before locking it so an absent (uncapped) row is
	// serialized just like an existing one. This also prevents two replicas from
	// independently deriving their cap from absence.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_settings (tenant_id, max_sends_per_hour, updated_at)
VALUES ($1::uuid, NULL, clock_timestamp())
ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: ensure sending settings: %w", err)
	}

	var priorCap *int
	if err := tx.QueryRow(ctx, `
SELECT max_sends_per_hour
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid
 FOR UPDATE`, tenantID).Scan(&priorCap); err != nil {
		return result, fmt.Errorf("deliverability throttle: lock sending cap: %w", err)
	}

	current := defaultUncappedHourlyBaseline
	if priorCap != nil && *priorCap > 0 {
		current = *priorCap
	}
	nextCap := int(float64(current) * AutoThrottleReductionPct)
	if nextCap < 1 {
		nextCap = 1
	}
	if w.Deps.CapCoordinator == nil {
		return result, fmt.Errorf("deliverability throttle: %w", sending.ErrCapCoordinationUnavailable)
	}
	fencedCtx, fencedCancel := sending.WithCapMutationDeadline(ctx)
	defer fencedCancel()
	lease, err := w.Deps.CapCoordinator.BeginCapChangeLocked(
		fencedCtx, tx, tenantID, priorCap, &nextCap,
	)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: begin shared cap change: %w", err)
	}
	fenceOpen := true
	defer func() {
		if !fenceOpen {
			return
		}
		if rollbackErr := rollbackThrottleCapMutation(fencedCtx, tx); rollbackErr != nil {
			w.Deps.log().Error("deliverability throttle: rollback before shared cap fence abort",
				"tenant", tenantID, "err", rollbackErr.Error())
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
		defer cancel()
		if abortErr := w.Deps.CapCoordinator.AbortCapChange(cleanupCtx, lease); abortErr != nil {
			w.Deps.log().Error("deliverability throttle: abort shared cap fence",
				"tenant", tenantID, "err", abortErr.Error())
		}
	}()

	reason := "auto: reputation_repair score=" + itoa(score)
	var overrideID int64
	err = tx.QueryRow(fencedCtx, `
INSERT INTO deliverability_repair_overrides
    (tenant_id, prior_max_sends_per_hour, throttled_max_sends_per_hour,
     reason, created_at)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id) WHERE cleared_at IS NULL DO NOTHING
RETURNING id`, tenantID, priorCap, nextCap, reason, observedAt).Scan(&overrideID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The unique index chose another transaction. The advisory lock should
		// make this exceptional, but treating it as a clean non-winner keeps the
		// database invariant authoritative if another writer omits the lock.
		if err := tx.Commit(fencedCtx); err != nil {
			return result, fmt.Errorf("deliverability throttle: commit losing observation: %w", err)
		}
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: insert active override: %w", err)
	}

	var capUpdatedAt time.Time
	err = tx.QueryRow(fencedCtx, `
UPDATE tenant_sending_settings
   SET max_sends_per_hour = $2,
       updated_by_user_id = NULL,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid
RETURNING updated_at`, tenantID, nextCap).Scan(&capUpdatedAt)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: install sending cap: %w", err)
	}

	// The record of WHY, written in the same transaction as the cap: a cap that
	// exists without its justification is the state an operator finds during an
	// incident and cannot explain.
	tag, err := tx.Exec(fencedCtx, `
INSERT INTO deliverability_remediations
    (tenant_id, applied_snapshot_id, applied_at, applied_score, override_id)
SELECT $1::uuid, snapshot.id, $3, snapshot.score, $5
  FROM deliverability_hub_snapshots AS snapshot
 WHERE snapshot.id = $2
   AND snapshot.tenant_id = $1::uuid
	   AND snapshot.score = $4
	   AND snapshot.sample_qualified IS TRUE
	   AND snapshot.model_version = $6`, tenantID, snapshotID, observedAt, score, overrideID,
		DeliverabilityScoreModelVersion)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: record remediation: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return result, fmt.Errorf(
			"deliverability throttle: snapshot %d does not match canonical tenant/model/score/qualification evidence",
			snapshotID,
		)
	}
	if err := db.Audit(
		fencedCtx,
		tx,
		automaticThrottleAuditMeta(tenantID),
		"deliverability.throttle.applied",
		"deliverability_repair_override",
		fmt.Sprintf("%d", overrideID),
		map[string]any{
			"prior_max_sends_per_hour":     priorCap,
			"throttled_max_sends_per_hour": nextCap,
			"score":                        score,
			"snapshot_id":                  snapshotID,
		},
	); err != nil {
		return result, fmt.Errorf("deliverability throttle: audit apply: %w", err)
	}
	if err := sending.RecordCapMutationReceipt(
		fencedCtx, tx, lease, &nextCap, capUpdatedAt,
	); err != nil {
		return result, err
	}

	if commitErr := w.Deps.commitThrottleCapMutation(fencedCtx, tx); commitErr != nil {
		fenceOpen = false
		if rollbackErr := rollbackThrottleCapMutation(fencedCtx, tx); rollbackErr != nil {
			return result, fmt.Errorf(
				"%w: resolve failed apply transaction: %v (commit error: %v)",
				ErrThrottleCommitOutcomeUnknown, rollbackErr, commitErr,
			)
		}
		receiptCtx, receiptCancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 10*time.Second)
		committed, receiptErr := w.Deps.throttleCapMutationCommitted(receiptCtx, tenantID, lease.Token)
		receiptCancel()
		if receiptErr != nil {
			return result, fmt.Errorf("%w: apply receipt: %v (commit error: %v)",
				ErrThrottleCommitOutcomeUnknown, receiptErr, commitErr)
		}
		if !committed {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
			abortErr := w.Deps.CapCoordinator.AbortCapChange(cleanupCtx, lease)
			cancel()
			if abortErr != nil {
				w.Deps.log().Error("deliverability throttle: abort disproven apply fence",
					"tenant", tenantID, "err", abortErr.Error())
			}
			return result, fmt.Errorf("deliverability throttle: commit apply: %w", commitErr)
		}
	}
	fenceOpen = false
	result.Applied = true
	result.OverrideID = overrideID
	result.NextCap = nextCap
	if priorCap != nil {
		result.PriorCap = *priorCap
	}
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
	finishErr := w.Deps.CapCoordinator.CommitCapChange(finishCtx, lease, &nextCap)
	finishCancel()
	if finishErr != nil {
		result.CapConvergencePending = true
		w.Deps.log().Error("deliverability throttle: cap committed but shared convergence is pending",
			"tenant", tenantID, "override_id", overrideID, "err", finishErr.Error())
	}
	return result, nil
}

// verifyThrottleReleaseEvidence re-reads, under the clear transaction, the
// snapshot the caller presented as recovery evidence and the tenant's current
// recovery observation, and confirms that snapshot is still the latest
// qualified recovery sample. A nil release (a plain administrative clear) needs
// no evidence and returns a nil sampled-at time.
func verifyThrottleReleaseEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	release *throttleReleaseEvidence,
) (*time.Time, error) {
	if release == nil {
		return nil, nil
	}
	if release.SnapshotID <= 0 || release.Score < 0 || release.Score > 100 {
		return nil, fmt.Errorf("%w: invalid snapshot/score", ErrThrottleReleaseEvidenceChanged)
	}
	var sampledAt time.Time
	var canonicalScore int
	if err := tx.QueryRow(ctx, `
SELECT sampled_at, score
  FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND id = $2
	AND score = $3
	AND sample_qualified IS TRUE
	AND model_version = $4`, tenantID, release.SnapshotID, release.Score,
		DeliverabilityScoreModelVersion).Scan(
		&sampledAt, &canonicalScore,
	); err != nil {
		return nil, fmt.Errorf("%w: snapshot is not exact tenant/score evidence: %v",
			ErrThrottleReleaseEvidenceChanged, err)
	}
	var current throttleObservation
	if err := tx.QueryRow(ctx, `
SELECT high_since, last_sampled_at, last_score, sample_qualified
  FROM deliverability_throttle_state
 WHERE tenant_id = $1::uuid
 FOR UPDATE`, tenantID).Scan(
		&current.HighSince,
		&current.LastSampledAt,
		&current.LastScore,
		&current.SampleQualified,
	); err != nil {
		return nil, fmt.Errorf("%w: read current recovery evidence: %v",
			ErrThrottleReleaseEvidenceChanged, err)
	}
	sampledAt = sampledAt.UTC()
	if !current.LastSampledAt.UTC().Equal(sampledAt) || current.LastScore != canonicalScore ||
		!shouldReleaseThrottle(current.LastScore, current.SampleQualified, current.HighSince, sampledAt) {
		return nil, fmt.Errorf("%w: snapshot %d is no longer the latest qualified recovery sample",
			ErrThrottleReleaseEvidenceChanged, release.SnapshotID)
	}
	return &sampledAt, nil
}

// clearOverride restores the cap captured by one exact active override ID. The
// same advisory lock used by apply serializes clear/apply races; the settings
// row lock also serializes unrelated cap edits. Resetting low_since forces a
// fresh 24-hour low period before the worker can throttle again.

func (d *Deps) clearOverride(
	ctx context.Context,
	tenantID, by string,
	auditMeta db.AuditMeta,
) (throttleClearResult, error) {
	return d.clearOverrideWithRelease(ctx, tenantID, by, auditMeta, nil)
}

func (d *Deps) clearOverrideWithRelease(
	ctx context.Context,
	tenantID, by string,
	auditMeta db.AuditMeta,
	release *throttleReleaseEvidence,
) (throttleClearResult, error) {
	var result throttleClearResult
	if d == nil || d.Pool == nil {
		return result, errors.New("deliverability throttle: nil dependencies")
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return result, errors.New("deliverability throttle: tenant id is required")
	}
	by = strings.TrimSpace(by)
	if by == "" {
		by = "admin"
	}
	if auditMeta.TenantID == "" {
		auditMeta.TenantID = tenantID
	}
	if auditMeta.TenantID != tenantID {
		return result, errors.New("deliverability throttle: audit tenant mismatch")
	}

	tx, err := db.WithTenantOptions(ctx, d.Pool, tenantID, sending.CapMutationTxOptions())
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: begin clear transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := lockTenantThrottle(ctx, tx, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: %w", err)
	}
	canonicalReleaseSampledAt, err := verifyThrottleReleaseEvidence(ctx, tx, tenantID, release)
	if err != nil {
		return result, err
	}
	if err := sending.LockCapMutation(ctx, tx, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: %w", err)
	}

	clearedAt := d.now().UTC()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_settings (tenant_id, max_sends_per_hour, updated_at)
VALUES ($1::uuid, NULL, clock_timestamp())
	ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return result, fmt.Errorf("deliverability throttle: ensure settings for clear: %w", err)
	}
	var currentCap *int
	if err := tx.QueryRow(ctx, `
SELECT max_sends_per_hour
  FROM tenant_sending_settings
	 WHERE tenant_id = $1::uuid
	 FOR UPDATE`, tenantID).Scan(&currentCap); err != nil {
		return result, fmt.Errorf("deliverability throttle: lock cap for clear: %w", err)
	}

	var (
		overrideID   int64
		priorCap     *int
		installedCap int
	)
	if err := tx.QueryRow(ctx, `
SELECT id, prior_max_sends_per_hour, throttled_max_sends_per_hour
  FROM deliverability_repair_overrides
 WHERE tenant_id = $1::uuid
   AND cleared_at IS NULL
	 FOR UPDATE`, tenantID).Scan(&overrideID, &priorCap, &installedCap); err != nil {
		return result, fmt.Errorf("deliverability throttle: select active override: %w", err)
	}
	if !throttleCapStillInstalled(currentCap, installedCap) {
		var currentValue any
		if currentCap != nil {
			currentValue = *currentCap
		}
		return result, fmt.Errorf(
			"%w: override %d installed %d, current cap is %v",
			ErrThrottleCapDrift,
			overrideID,
			installedCap,
			currentValue,
		)
	}
	if d.CapCoordinator == nil {
		return result, fmt.Errorf("deliverability throttle: %w", sending.ErrCapCoordinationUnavailable)
	}
	fencedCtx, fencedCancel := sending.WithCapMutationDeadline(ctx)
	defer fencedCancel()
	lease, err := d.CapCoordinator.BeginCapChangeLocked(
		fencedCtx, tx, tenantID, currentCap, priorCap,
	)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: begin shared cap restoration: %w", err)
	}
	fenceOpen := true
	defer func() {
		if !fenceOpen {
			return
		}
		if rollbackErr := rollbackThrottleCapMutation(fencedCtx, tx); rollbackErr != nil {
			d.log().Error("deliverability throttle: rollback before shared cap restoration abort",
				"tenant", tenantID, "err", rollbackErr.Error())
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
		defer cancel()
		if abortErr := d.CapCoordinator.AbortCapChange(cleanupCtx, lease); abortErr != nil {
			d.log().Error("deliverability throttle: abort shared cap restoration fence",
				"tenant", tenantID, "err", abortErr.Error())
		}
	}()

	tag, err := tx.Exec(fencedCtx, `
UPDATE deliverability_repair_overrides
   SET cleared_at = $3,
       cleared_by = $4
 WHERE tenant_id = $1::uuid
   AND id = $2
   AND cleared_at IS NULL`, tenantID, overrideID, clearedAt, by)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: clear override %d: %w", overrideID, err)
	}
	if tag.RowsAffected() != 1 {
		return result, fmt.Errorf(
			"deliverability throttle: clear override %d affected %d rows, want 1",
			overrideID,
			tag.RowsAffected(),
		)
	}

	var capUpdatedAt time.Time
	err = tx.QueryRow(fencedCtx, `
UPDATE tenant_sending_settings
   SET max_sends_per_hour = $2,
       updated_by_user_id = $3::uuid,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid
RETURNING updated_at`, tenantID, priorCap, auditMeta.UserID).Scan(&capUpdatedAt)
	if err != nil {
		return result, fmt.Errorf("deliverability throttle: restore sending cap: %w", err)
	}

	if _, err := tx.Exec(fencedCtx, `
UPDATE deliverability_throttle_state
   SET low_since = NULL,
	   high_since = NULL,
       updated_at = $2
	 WHERE tenant_id = $1::uuid`, tenantID, clearedAt); err != nil {
		return result, fmt.Errorf("deliverability throttle: reset low-score window: %w", err)
	}

	releaseKind := remediationReleaseManual
	var releaseSnapshotID any
	var releaseScore any
	var releaseSampledAt any
	if canonicalReleaseSampledAt != nil {
		releaseSampledAt = canonicalReleaseSampledAt.UTC()
	}
	if release != nil {
		releaseKind = remediationReleaseAutomatic
	}
	// Close only the episode tied to this exact override, in the same
	// transaction as the cap restoration and override clear. A post-commit
	// best-effort update can leave the partial-unique open row behind, suppress
	// the next episode, and later stamp it with another override's evidence.
	var exactOpenEpisode, mismatchedOpenEpisode bool
	if err := tx.QueryRow(fencedCtx, `
SELECT EXISTS (
           SELECT 1
             FROM deliverability_remediations
            WHERE tenant_id = $1::uuid
              AND released_at IS NULL
              AND override_id = $2
       ),
       EXISTS (
           SELECT 1
             FROM deliverability_remediations
            WHERE tenant_id = $1::uuid
              AND released_at IS NULL
              AND override_id IS DISTINCT FROM $2
       )`, tenantID, overrideID).Scan(&exactOpenEpisode, &mismatchedOpenEpisode); err != nil {
		return result, fmt.Errorf("deliverability throttle: verify remediation episode ownership: %w", err)
	}
	if mismatchedOpenEpisode {
		return result, fmt.Errorf(
			"%w: open remediation does not belong to override %d",
			ErrThrottleRemediationEpisodeMismatch,
			overrideID,
		)
	}
	if !exactOpenEpisode {
		return result, fmt.Errorf(
			"%w: override %d has no open remediation",
			ErrThrottleRemediationEpisodeMismatch,
			overrideID,
		)
	}
	if release == nil {
		tag, err := tx.Exec(fencedCtx, `
UPDATE deliverability_remediations
   SET released_snapshot_id = NULL,
       released_at = $3,
       released_score = NULL,
       release_kind = $4
 WHERE tenant_id = $1::uuid
   AND override_id = $2
   AND released_at IS NULL`, tenantID, overrideID, clearedAt, remediationReleaseManual)
		if err != nil {
			return result, fmt.Errorf("deliverability throttle: close manual remediation episode: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return result, fmt.Errorf("deliverability throttle: exact manual remediation changed concurrently")
		}
	}
	if release != nil {
		var sampledAt time.Time
		err := tx.QueryRow(fencedCtx, `
UPDATE deliverability_remediations AS remediation
   SET released_snapshot_id = snapshot.id,
       released_at = $4,
       released_score = snapshot.score,
       release_kind = $6
  FROM deliverability_hub_snapshots AS snapshot
 WHERE remediation.tenant_id = $1::uuid
   AND remediation.override_id = $2
   AND remediation.released_at IS NULL
   AND snapshot.id = $3
   AND snapshot.tenant_id = $1::uuid
   AND snapshot.score = $5
	AND snapshot.sample_qualified IS TRUE
	AND snapshot.model_version = $7
RETURNING snapshot.id, snapshot.score, snapshot.sampled_at`,
			tenantID, overrideID, release.SnapshotID, clearedAt, release.Score,
			remediationReleaseAutomatic, DeliverabilityScoreModelVersion).Scan(
			&releaseSnapshotID, &releaseScore, &sampledAt,
		)
		if err != nil {
			return result, fmt.Errorf(
				"deliverability throttle: release snapshot does not match exact tenant/score evidence: %w",
				err,
			)
		}
		releaseSampledAt = sampledAt.UTC()
	}
	if err := db.Audit(
		fencedCtx,
		tx,
		auditMeta,
		"deliverability.throttle.cleared",
		"deliverability_repair_override",
		fmt.Sprintf("%d", overrideID),
		map[string]any{
			"throttled_max_sends_per_hour": installedCap,
			"restored_max_sends_per_hour":  priorCap,
			"cleared_by":                   by,
			"release_kind":                 releaseKind,
			"release_snapshot_id":          releaseSnapshotID,
			"release_score":                releaseScore,
			"release_sampled_at":           releaseSampledAt,
		},
	); err != nil {
		return result, fmt.Errorf("deliverability throttle: audit clear: %w", err)
	}
	if err := sending.RecordCapMutationReceipt(
		fencedCtx, tx, lease, priorCap, capUpdatedAt,
	); err != nil {
		return result, err
	}

	if commitErr := d.commitThrottleCapMutation(fencedCtx, tx); commitErr != nil {
		fenceOpen = false
		if rollbackErr := rollbackThrottleCapMutation(fencedCtx, tx); rollbackErr != nil {
			return result, fmt.Errorf(
				"%w: resolve failed clear transaction: %v (commit error: %v)",
				ErrThrottleCommitOutcomeUnknown, rollbackErr, commitErr,
			)
		}
		receiptCtx, receiptCancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 10*time.Second)
		committed, receiptErr := d.throttleCapMutationCommitted(receiptCtx, tenantID, lease.Token)
		receiptCancel()
		if receiptErr != nil {
			return result, fmt.Errorf("%w: clear receipt: %v (commit error: %v)",
				ErrThrottleCommitOutcomeUnknown, receiptErr, commitErr)
		}
		if !committed {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
			abortErr := d.CapCoordinator.AbortCapChange(cleanupCtx, lease)
			cancel()
			if abortErr != nil {
				d.log().Error("deliverability throttle: abort disproven clear fence",
					"tenant", tenantID, "err", abortErr.Error())
			}
			return result, fmt.Errorf("deliverability throttle: commit clear: %w", commitErr)
		}
	}
	fenceOpen = false
	result.Cleared = true
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(fencedCtx), 5*time.Second)
	finishErr := d.CapCoordinator.CommitCapChange(finishCtx, lease, priorCap)
	finishCancel()
	if finishErr != nil {
		result.CapConvergencePending = true
		d.log().Error("deliverability throttle: cap restored but shared convergence is pending",
			"tenant", tenantID, "override_id", overrideID, "err", finishErr.Error())
	}
	return result, nil
}

// shouldReleaseThrottle decides whether an automatic cap has earned its release.
//
// Separated from the transaction so the POLICY is testable without a database.
// Whether the worker finds the right tenants is a query concern; whether a
// recovered tenant is let go is not, and it was previously untestable because
// no code path expressed it at all — `clearOverride`'s only non-test caller was
// the admin route, so a tenant whose reputation recovered stayed at half their
// sending rate until a human noticed. Nothing prompts that: recovery is exactly
// the event that produces no alert.
func shouldReleaseThrottle(score int, qualified bool, highSince *time.Time, now time.Time) bool {
	// An unqualified sample is not evidence in either direction — the entry rule
	// treats it the same way.
	if !qualified {
		return false
	}
	if score < AutoThrottleRecoveryThreshold {
		return false
	}
	if highSince == nil {
		return false
	}
	return now.Sub(*highSince) >= AutoThrottleRecoveryWindow
}

// releaseIfRecovered lifts an automatic cap once the recovery rule is satisfied.
//
// Called after the observation transaction commits: clearOverride opens its own
// transaction and takes the same tenant advisory lock, so invoking it from
// inside the observation tx would deadlock against itself. Reusing it rather
// than inlining a second clear is deliberate — the cap-drift check, the
// exact-override targeting and the low-window reset stay one implementation, and
// the copy that stops getting updated is always the one no human exercises.
//
// A drifted cap is not an error here. It means an admin or a plan change moved
// the limit while the override was active; that newer decision wins, and the
// override is left for a person rather than overwritten by a worker.
func (w *Worker) releaseIfRecovered(
	ctx context.Context,
	tenantID string,
	due bool,
	evidence throttleReleaseEvidence,
) throttleClearResult {
	if !due || w.Deps == nil {
		return throttleClearResult{}
	}
	result, err := w.Deps.clearOverrideWithRelease(
		ctx,
		tenantID,
		"auto: reputation_recovered",
		automaticThrottleAuditMeta(tenantID),
		&evidence,
	)
	if err != nil {
		if !errors.Is(err, ErrThrottleCapDrift) &&
			!errors.Is(err, ErrThrottleReleaseEvidenceChanged) &&
			!errors.Is(err, pgx.ErrNoRows) {
			w.Deps.log().Warn("deliverability_hub: auto-release failed",
				"tenant", tenantID, "err", err.Error())
		}
		return throttleClearResult{}
	}
	return result
}
