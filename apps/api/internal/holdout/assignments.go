// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	AssignmentVersion      = "postwave.holdout-assignment.v2"
	rotationWindow         = 90 * 24 * time.Hour
	maximumControlExposure = 0.15
)

var (
	ErrAssignmentInput       = errors.New("holdout: invalid assignment input")
	ErrAssignmentUnavailable = errors.New("holdout: assignment contract unavailable")
	ErrHoldoutAlreadyDecided = errors.New("holdout: assignment set already decided")
)

// Assignment is the in-memory form of one immutable intent-to-treat decision.
// RecipientID is a subscriber UUID, never an address or an unsalted email
// digest.  The database retains that random identifier after contact erasure,
// but deletion of the subscriber removes the only mapping back to PII.
type Assignment struct {
	RecipientID         string
	Arm                 string
	Bucket              int
	Reason              string
	HoldoutPercent      float64
	SeedSHA256          string
	ExposureWindowStart time.Time
	PriorAssignments90d int
	PriorControl90d     int
	AssignedAt          time.Time
}

// AssignmentPlan is frozen atomically with queue materialisation.  The
// treatment slice is returned separately to the caller so the control rows can
// never accidentally enter campaign_recipients.
type AssignmentPlan struct {
	TenantID    string
	CampaignID  string
	Assignments []Assignment
	Treatment   []string
	Control     []string
}

func (p *AssignmentPlan) TreatmentCount() int {
	if p == nil {
		return 0
	}
	return len(p.Treatment)
}

func (p *AssignmentPlan) ControlCount() int {
	if p == nil {
		return 0
	}
	return len(p.Control)
}

type exposure struct {
	recipientID  string
	priorTotal   int
	priorControl int
}

// PlanAudience computes a deterministic assignment once the queue path has
// applied consent, suppression, frequency, global-control, and other
// eligibility filters.  It performs no writes; PersistAssignmentPlanTx freezes
// the returned plan in the same transaction as campaign_recipients.
func PlanAudience(
	ctx context.Context,
	pool *db.Pool,
	tenantID, campaignID string,
	candidates []string,
) (*AssignmentPlan, error) {
	// A zero time asks the repository for database time. Replica wall clocks
	// may differ; assignment ordering and the 90-day exposure fence may not.
	return planAudienceAt(ctx, pool, tenantID, campaignID, candidates, time.Time{})
}

func planAudienceAt(
	ctx context.Context,
	pool *db.Pool,
	tenantID, campaignID string,
	candidates []string,
	now time.Time,
) (*AssignmentPlan, error) {
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if pool == nil || tenantID == "" || campaignID == "" {
		return nil, fmt.Errorf("%w: tenant, campaign, and pool are required", ErrAssignmentInput)
	}
	// Queue materialisation already de-duplicates on lower(email).  Do the same
	// before cohort selection so one duplicate address cannot consume two
	// control slots or produce an assignment/count mismatch at commit.
	ordered := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		email := strings.ToLower(strings.TrimSpace(candidate))
		if email == "" {
			return nil, fmt.Errorf("%w: candidate email is empty", ErrAssignmentInput)
		}
		if _, exists := seen[email]; exists {
			continue
		}
		seen[email] = struct{}{}
		ordered = append(ordered, email)
	}
	if len(ordered) == 0 {
		return nil, nil
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if now.IsZero() {
		if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&now); err != nil {
			return nil, err
		}
	}
	now = now.UTC()

	var seed string
	var percent float64
	var decidedAt *time.Time
	var ledgerVersion *string
	err = tx.QueryRow(ctx, `
SELECT seed, percent::float8, decided_at, assignment_ledger_version
  FROM campaign_holdouts
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, campaignID).
		Scan(&seed, &percent, &decidedAt, &ledgerVersion)
	if errors.Is(err, pgx.ErrNoRows) || percent <= 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if decidedAt != nil {
		return nil, ErrHoldoutAlreadyDecided
	}
	if ledgerVersion != nil {
		return nil, fmt.Errorf("%w: undecided holdout already carries a ledger version", ErrAssignmentUnavailable)
	}

	windowStart := now.Add(-rotationWindow)
	rows, err := tx.Query(ctx, `
WITH requested(email) AS (
    SELECT unnest($2::text[])
)
SELECT lower(subscriber.email::text) AS email,
       subscriber.id::text,
       count(assignment.id) FILTER (
           WHERE assignment.assigned_at >= $3
             AND assignment.assigned_at <= $4
       )::integer AS prior_total,
       count(assignment.id) FILTER (
           WHERE assignment.assigned_at >= $3
             AND assignment.assigned_at <= $4
             AND assignment.arm = 'control'
       )::integer AS prior_control
  FROM requested
  JOIN subscribers AS subscriber
    ON subscriber.tenant_id = $1::uuid
   AND lower(subscriber.email::text) = requested.email
  LEFT JOIN campaign_holdout_assignments AS assignment
    ON assignment.tenant_id = subscriber.tenant_id
   AND assignment.recipient_id = subscriber.id
 GROUP BY lower(subscriber.email::text), subscriber.id`, tenantID, ordered, windowStart, now.UTC())
	if err != nil {
		return nil, err
	}
	exposures := make(map[string]exposure, len(ordered))
	for rows.Next() {
		var email string
		var item exposure
		if err := rows.Scan(&email, &item.recipientID, &item.priorTotal, &item.priorControl); err != nil {
			rows.Close()
			return nil, err
		}
		exposures[email] = item
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(exposures) != len(ordered) {
		return nil, fmt.Errorf("%w: every holdout candidate must resolve to one tenant subscriber", ErrAssignmentUnavailable)
	}

	seedDigest := sha256.Sum256([]byte(seed))
	seedSHA256 := hex.EncodeToString(seedDigest[:])
	plan := &AssignmentPlan{
		TenantID: tenantID, CampaignID: campaignID,
		Assignments: make([]Assignment, 0, len(ordered)),
		Treatment:   make([]string, 0, len(ordered)),
		Control:     make([]string, 0, len(ordered)),
	}
	cutoff := int(percent + 0.5)
	for _, email := range ordered {
		history := exposures[email]
		bucket := AssignBucket(seed, history.recipientID)
		arm, reason := assignmentArm(bucket, cutoff, history.priorTotal, history.priorControl)
		plan.Assignments = append(plan.Assignments, Assignment{
			RecipientID:         history.recipientID,
			Arm:                 arm,
			Bucket:              bucket,
			Reason:              reason,
			HoldoutPercent:      percent,
			SeedSHA256:          seedSHA256,
			ExposureWindowStart: windowStart,
			PriorAssignments90d: history.priorTotal,
			PriorControl90d:     history.priorControl,
			AssignedAt:          now,
		})
		if arm == "control" {
			plan.Control = append(plan.Control, email)
		} else {
			plan.Treatment = append(plan.Treatment, email)
		}
	}

	// The database digest sorts by recipient UUID.  Sorting the write plan too
	// keeps tests, CopyFrom batches, and operational inspection deterministic.
	sort.Slice(plan.Assignments, func(i, j int) bool {
		return plan.Assignments[i].RecipientID < plan.Assignments[j].RecipientID
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return plan, nil
}

func assignmentArm(bucket, cutoff, priorTotal, priorControl int) (arm, reason string) {
	if bucket >= cutoff {
		return "treatment", "deterministic"
	}
	// The cap is evaluated against the projected 90-day ledger, not a mutable
	// profile counter. A recipient with no experiment history may enter control
	// once; after that bootstrap observation, another control assignment is
	// refused until treatment exposures bring the projected rate back under the
	// cap. Without the bootstrap exception no new recipient could ever enter a
	// control arm (1/1 is necessarily above 15%), and the product would claim to
	// run experiments while permanently producing an empty control population.
	projectedRate := float64(priorControl+1) / float64(priorTotal+1)
	if priorTotal == 0 || projectedRate <= maximumControlExposure {
		return "control", "deterministic"
	}
	return "treatment", "rotation_cap"
}

// PersistAssignmentPlanTx writes and freezes the exact assignment set inside
// the campaign queue transaction.  The caller must insert campaign recipients
// from plan.Treatment only; this function verifies the treatment count supplied
// by that caller before allowing the decision to commit.
func PersistAssignmentPlanTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
	plan *AssignmentPlan,
	queuedTreatment int,
) error {
	if plan == nil {
		return nil
	}
	if tx == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(campaignID) == "" {
		return fmt.Errorf("%w: transaction, tenant, and campaign are required", ErrAssignmentInput)
	}
	if plan.TenantID != tenantID || plan.CampaignID != campaignID {
		return fmt.Errorf("%w: assignment plan scope mismatch", ErrAssignmentInput)
	}
	if len(plan.Assignments) != len(plan.Treatment)+len(plan.Control) {
		return fmt.Errorf("%w: assignment population is inconsistent", ErrAssignmentInput)
	}
	if queuedTreatment != len(plan.Treatment) {
		return fmt.Errorf("%w: queued treatment count %d differs from frozen plan %d",
			ErrAssignmentInput, queuedTreatment, len(plan.Treatment))
	}
	if len(plan.Assignments) == 0 {
		return fmt.Errorf("%w: assignment plan is empty", ErrAssignmentInput)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.holdout_assignment_writer', 'true', true)`); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
CREATE TEMP TABLE _holdout_assignment_stage (
    recipient_id            uuid,
    arm                     text,
    bucket                  smallint,
    assignment_reason       text,
    holdout_percent         numeric(5,2),
    seed_sha256             text,
    exposure_window_start   timestamptz,
    prior_assignments_90d   integer,
    prior_control_90d       integer,
    assigned_at             timestamptz
) ON COMMIT DROP`); err != nil {
		return fmt.Errorf("create holdout assignment stage: %w", err)
	}
	if _, err := tx.CopyFrom(ctx,
		pgx.Identifier{"_holdout_assignment_stage"},
		[]string{
			"recipient_id", "arm", "bucket", "assignment_reason",
			"holdout_percent", "seed_sha256", "exposure_window_start",
			"prior_assignments_90d", "prior_control_90d", "assigned_at",
		},
		pgx.CopyFromSlice(len(plan.Assignments), func(i int) ([]any, error) {
			a := plan.Assignments[i]
			return []any{
				a.RecipientID, a.Arm, int16(a.Bucket), a.Reason,
				a.HoldoutPercent, a.SeedSHA256, a.ExposureWindowStart,
				a.PriorAssignments90d, a.PriorControl90d, a.AssignedAt,
			}, nil
		}),
	); err != nil {
		return fmt.Errorf("stage holdout assignments: %w", err)
	}

	tag, err := tx.Exec(ctx, `
INSERT INTO campaign_holdout_assignments (
    tenant_id, campaign_id, recipient_id, arm, bucket, assignment_reason,
    holdout_percent, seed_sha256, exposure_window_start,
    prior_assignments_90d, prior_control_90d, assignment_version, assigned_at
)
SELECT $1::uuid, $2::uuid, stage.recipient_id, stage.arm, stage.bucket,
       stage.assignment_reason, stage.holdout_percent, stage.seed_sha256,
       stage.exposure_window_start, stage.prior_assignments_90d,
       stage.prior_control_90d, $3, stage.assigned_at
  FROM _holdout_assignment_stage AS stage
  JOIN subscribers AS subscriber
    ON subscriber.tenant_id = $1::uuid
   AND subscriber.id = stage.recipient_id`, tenantID, campaignID, AssignmentVersion)
	if err != nil {
		return fmt.Errorf("persist holdout assignments: %w", err)
	}
	if tag.RowsAffected() != int64(len(plan.Assignments)) {
		return fmt.Errorf("%w: persisted %d of %d assignment recipients",
			ErrAssignmentUnavailable, tag.RowsAffected(), len(plan.Assignments))
	}

	var ledgerSHA256 string
	if err := tx.QueryRow(ctx, `
SELECT campaign_holdout_assignment_set_sha256($1::uuid, $2::uuid)`,
		tenantID, campaignID).Scan(&ledgerSHA256); err != nil {
		return fmt.Errorf("hash holdout assignment set: %w", err)
	}
	tag, err = tx.Exec(ctx, `
UPDATE campaign_holdouts
   SET decided_at = $3,
       held_out_count = $4,
       sent_count = $5,
       assignment_ledger_version = $6,
       assignment_ledger_sha256 = $7,
       updated_at = $3
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND decided_at IS NULL`,
		tenantID, campaignID, plan.Assignments[0].AssignedAt,
		len(plan.Control), len(plan.Treatment), AssignmentVersion, ledgerSHA256)
	if err != nil {
		return fmt.Errorf("freeze holdout assignment set: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrHoldoutAlreadyDecided
	}
	return nil
}
