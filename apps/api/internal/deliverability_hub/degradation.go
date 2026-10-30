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
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

const degradationAdvisoryLockSeed int64 = 0x5057444547524144 // "PWDEGRAD"

type degradationTransitionClaim struct {
	Claimed           bool
	SnapshotOwned     bool
	PreviousFound     bool
	PreviousQualified bool
	PreviousScore     int
	FromSnapshotID    int64
	ToSnapshotID      int64

	// These fields are read back from the durable snapshot on both the insert
	// and cadence-reuse paths. A second replica may have computed a different
	// score or qualification result inside the same cadence bucket; downstream
	// throttle policy must use the observation actually named by ToSnapshotID,
	// never that second replica's unpersisted HubScore.
	ToSnapshotScore           int
	ToSnapshotModelVersion    string
	ToSnapshotSampleQualified bool
	ToSnapshotSampleSize      int64
	ToSnapshotSampledAt       time.Time
}

func (c degradationTransitionClaim) validateThrottleSnapshot(expectedModel string) error {
	expectedModel = strings.TrimSpace(expectedModel)
	switch {
	case c.ToSnapshotID <= 0:
		return errors.New("deliverability degradation: canonical throttle snapshot id is required")
	case c.ToSnapshotScore < 0 || c.ToSnapshotScore > 100:
		return fmt.Errorf(
			"deliverability degradation: canonical throttle snapshot score %d is outside 0..100",
			c.ToSnapshotScore,
		)
	case expectedModel == "" || c.ToSnapshotModelVersion != expectedModel:
		return fmt.Errorf(
			"deliverability degradation: canonical throttle snapshot model %q does not match %q",
			c.ToSnapshotModelVersion,
			expectedModel,
		)
	case c.ToSnapshotSampleSize < 0:
		return errors.New("deliverability degradation: canonical throttle snapshot sample size is negative")
	case c.ToSnapshotSampleQualified != (c.ToSnapshotSampleSize >= int64(MinimumRateSampleSends)):
		return errors.New("deliverability degradation: canonical throttle snapshot qualification does not match its sample size")
	case c.ToSnapshotSampledAt.IsZero():
		return errors.New("deliverability degradation: canonical throttle snapshot sampled_at is required")
	default:
		return nil
	}
}

func (w *Worker) degradationSnapshotBucket(at time.Time) time.Time {
	cadence := time.Hour
	if w != nil && w.Deps != nil && w.Deps.HubInterval > 0 {
		cadence = w.Deps.HubInterval
	}
	return at.UTC().Truncate(cadence)
}

func isQualifiedDownwardCrossing(
	previousFound bool,
	previousQualified bool,
	previousScore int,
	currentQualified bool,
	currentScore int,
) bool {
	return previousFound &&
		previousQualified &&
		currentQualified &&
		previousScore >= DegradedScoreThreshold &&
		currentScore < DegradedScoreThreshold
}

func lockDegradationTransition(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	modelVersion string,
) error {
	lockKey := tenantID + ":" + modelVersion
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
		lockKey, degradationAdvisoryLockSeed); err != nil {
		return fmt.Errorf("acquire transition advisory lock: %w", err)
	}
	return nil
}

// recordSnapshotAndClaimDegradation serializes the previous-read, current
// snapshot insert, and downward-crossing claim for one tenant/model. The
// transaction-level lock makes replicas observe a single sequence; the claim
// table's unique source-snapshot key remains the durable final guard if another
// writer does not participate in the lock protocol.
func (w *Worker) recordSnapshotAndClaimDegradation(
	ctx context.Context,
	tenantID string,
	hub HubScore,
) (degradationTransitionClaim, error) {
	var result degradationTransitionClaim
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return result, errors.New("deliverability degradation: nil dependencies")
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return result, errors.New("deliverability degradation: tenant id is required")
	}
	modelVersion := strings.TrimSpace(hub.ModelVersion)
	if modelVersion == "" {
		return result, errors.New("deliverability degradation: model version is required")
	}
	if hub.Score < 0 || hub.Score > 100 {
		return result, fmt.Errorf("deliverability degradation: score %d is outside 0..100", hub.Score)
	}
	if hub.ComputedAt.IsZero() {
		return result, errors.New("deliverability degradation: computed_at is required")
	}

	// Bind both scopes: snapshots and the transactional webhook outbox are
	// tenant-isolated, while immutable degradation claims are worker-only.
	tx, err := db.WithWorkerScope(ctx, w.Deps.Pool)
	if err != nil {
		return result, fmt.Errorf("deliverability degradation: begin worker transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return result, fmt.Errorf("deliverability degradation: bind tenant scope: %w", err)
	}

	if err := lockDegradationTransition(ctx, tx, tenantID, modelVersion); err != nil {
		return result, fmt.Errorf("deliverability degradation: %w", err)
	}

	bucketAt := w.degradationSnapshotBucket(hub.ComputedAt)
	err = tx.QueryRow(ctx, `
SELECT id, score, model_version, sample_qualified, sample_size, sampled_at
  FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND model_version = $2
   AND observation_bucket_at = $3
 LIMIT 1`, tenantID, modelVersion, bucketAt).Scan(
		&result.ToSnapshotID,
		&result.ToSnapshotScore,
		&result.ToSnapshotModelVersion,
		&result.ToSnapshotSampleQualified,
		&result.ToSnapshotSampleSize,
		&result.ToSnapshotSampledAt,
	)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return result, fmt.Errorf("deliverability degradation: commit cadence reuse: %w", err)
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, fmt.Errorf("deliverability degradation: inspect cadence snapshot: %w", err)
	}

	err = tx.QueryRow(ctx, `
SELECT id, score, sample_qualified
  FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND model_version = $2
 ORDER BY id DESC
 LIMIT 1`, tenantID, modelVersion).Scan(
		&result.FromSnapshotID,
		&result.PreviousScore,
		&result.PreviousQualified,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		result.FromSnapshotID = 0
		result.PreviousScore = 0
		result.PreviousQualified = false
		result.PreviousFound = false
	} else if err != nil {
		return result, fmt.Errorf("deliverability degradation: read previous snapshot: %w", err)
	} else {
		result.PreviousFound = true
	}

	if err := tx.QueryRow(ctx, `
INSERT INTO deliverability_hub_snapshots
    (tenant_id, score, model_version, sample_qualified, sample_size,
     sampled_at, observation_bucket_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
RETURNING id, score, model_version, sample_qualified, sample_size, sampled_at`,
		tenantID,
		hub.Score,
		modelVersion,
		hub.SampleQualified,
		hub.Totals.Sends30d,
		hub.ComputedAt.UTC(),
		bucketAt,
	).Scan(
		&result.ToSnapshotID,
		&result.ToSnapshotScore,
		&result.ToSnapshotModelVersion,
		&result.ToSnapshotSampleQualified,
		&result.ToSnapshotSampleSize,
		&result.ToSnapshotSampledAt,
	); err != nil {
		return result, fmt.Errorf("deliverability degradation: insert current snapshot: %w", err)
	}
	result.SnapshotOwned = true

	if isQualifiedDownwardCrossing(
		result.PreviousFound,
		result.PreviousQualified,
		result.PreviousScore,
		hub.SampleQualified,
		hub.Score,
	) {
		var (
			claimedSnapshotID int64
			topCode           string
			topTitle          string
		)
		if breach := worstBreach(hub.Breaches); breach != nil {
			topCode = breach.Code
			topTitle = breach.Title
		}
		err = tx.QueryRow(ctx, `
INSERT INTO deliverability_degradation_claims
    (tenant_id, model_version, from_snapshot_id, to_snapshot_id,
     previous_score, current_score, previous_sample_qualified,
     current_sample_qualified, current_grade, top_breach_code,
     top_breach_title, breach_count, claimed_at, webhook_enqueued_at,
     operator_next_attempt_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, true, true, $7, $8, $9,
        $10, $11, $11, $11)
ON CONFLICT (tenant_id, model_version, from_snapshot_id) DO NOTHING
RETURNING to_snapshot_id`,
			tenantID,
			modelVersion,
			result.FromSnapshotID,
			result.ToSnapshotID,
			result.PreviousScore,
			hub.Score,
			hub.Grade,
			topCode,
			topTitle,
			len(hub.Breaches),
			hub.ComputedAt.UTC(),
		).Scan(&claimedSnapshotID)
		switch {
		case err == nil:
			result.Claimed = claimedSnapshotID == result.ToSnapshotID
		case errors.Is(err, pgx.ErrNoRows):
			result.Claimed = false
		default:
			return result, fmt.Errorf("deliverability degradation: claim downward crossing: %w", err)
		}
		if result.Claimed {
			sourceID := fmt.Sprintf(
				"deliverability-degradation:%s:%s:%d:%d",
				tenantID,
				modelVersion,
				result.FromSnapshotID,
				result.ToSnapshotID,
			)
			if _, err := (&outbound_webhooks.TransactionalFanout{}).Fire(
				ctx,
				tx,
				outbound_webhooks.TransactionalEvent{
					TenantID:      tenantID,
					EventType:     EventListHealthDegraded,
					SourceEventID: sourceID,
					Body: degradationEventPayload(
						tenantID,
						hub,
						result.ToSnapshotID,
					),
					OccurredAt: hub.ComputedAt.UTC(),
				},
			); err != nil {
				return result, fmt.Errorf(
					"deliverability degradation: enqueue webhook: %w", err,
				)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return result, fmt.Errorf("deliverability degradation: commit snapshot transition: %w", err)
	}
	return result, nil
}
