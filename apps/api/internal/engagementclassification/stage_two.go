// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// StageTwoStage names one of the PRD's two delayed re-evaluation moments.
//
// Stage 1 decides on arrival, with whatever evidence exists at arrival. For the
// FIRST event of a message that is a single row: one open, no siblings, no
// delivery time. A single open looks human. Forty identical opens two hundred
// milliseconds apart do not — and none of the other thirty-nine has happened
// yet when the first one is classified.
//
// Stage 2 is the SCHEDULER over that problem, not a second classifier. It
// re-runs the same rules over the same aggregate builder once the traffic has
// had time to take shape.
type StageTwoStage string

const (
	// StageTwoDelayed fires 60 seconds after the FIRST event of a message.
	StageTwoDelayed StageTwoStage = "delayed"
	// StageTwoConversionWindowClose fires when the attribution window closes,
	// which is the last moment a late human click can still change the picture.
	StageTwoConversionWindowClose StageTwoStage = "conversion_window_close"
)

func (stage StageTwoStage) Valid() bool {
	return stage == StageTwoDelayed || stage == StageTwoConversionWindowClose
}

const (
	// StageTwoDelay is the PRD's 60 seconds, measured from the first observed
	// event of a message. It is deliberately a constant rather than a knob: the
	// value participates in a persisted, immutable due_at, so two nodes running
	// different values would disagree about when a message settles.
	StageTwoDelay = 60 * time.Second

	// DefaultStageTwoConversionWindow mirrors the documented last-touch
	// attribution look-back (internal/conversions/attribution.go's
	// lastTouchAttributionWindow, 7 days). It is duplicated rather than imported
	// because that constant is unexported and importing the conversions package
	// here would invert the dependency direction: conversion attribution reads
	// engagement, not the other way round. Changing one without the other means
	// Stage 2 closes the books before or after attribution does.
	DefaultStageTwoConversionWindow = 7 * 24 * time.Hour

	minimumStageTwoConversionWindow = time.Hour
	maximumStageTwoConversionWindow = 90 * 24 * time.Hour

	defaultStageTwoSweepInterval = 30 * time.Second
	minimumStageTwoSweepInterval = 5 * time.Second
	maximumStageTwoSweepInterval = time.Hour

	// stageTwoMessageEventLimit matches loadMessageAggregate's own 10000-row
	// ceiling. Beyond it the aggregate refuses to be built at all, so evaluating
	// more events than that could never produce a verdict.
	stageTwoMessageEventLimit = 10000
)

var (
	// ErrStageTwoNotScheduled is returned when a caller asks to evaluate a
	// message that has no schedule row for the requested stage.
	ErrStageTwoNotScheduled = errors.New("engagementclassification: stage two evaluation is not scheduled")

	// stageTwoRunNamespace makes the reclassification run id a pure function of
	// the schedule row being evaluated — see stageTwoRunRequestID for the exact
	// material. That determinism IS the mutual exclusion: two workers reaching
	// the same due row read the same columns and contend for one row in
	// event_reclassification_runs, whose existing fenced lease decides the
	// winner. A random request id would mint a private run per worker and the
	// lease would guard nothing.
	stageTwoRunNamespace = uuid.MustParse("6f1b4a2c-9d3e-4f77-8a51-2c0f7b9d4e13")
)

// StageTwoEvaluation is one scheduled re-evaluation of one message.
type StageTwoEvaluation struct {
	TenantID            string
	MessageIdentityHash string
	Stage               StageTwoStage
	FirstEventAt        time.Time
	DueAt               time.Time
	State               string
}

// StageTwoResult reports one drain pass. The outcomes are kept separate on
// purpose: "another worker holds the lease" and "already evaluated" are healthy,
// while "failed" is not, and a single combined counter would hide that.
type StageTwoResult struct {
	Due                int
	Evaluated          int
	AlreadyEvaluated   int
	LeaseHeldElsewhere int
	Failed             int
	EventsSuperseded   int64
	EventsUnchanged    int64
}

func (result *StageTwoResult) add(other StageTwoResult) {
	result.Due += other.Due
	result.Evaluated += other.Evaluated
	result.AlreadyEvaluated += other.AlreadyEvaluated
	result.LeaseHeldElsewhere += other.LeaseHeldElsewhere
	result.Failed += other.Failed
	result.EventsSuperseded += other.EventsSuperseded
	result.EventsUnchanged += other.EventsUnchanged
}

type StageTwoSweepResult struct {
	StageTwoResult
	TenantCount      int
	NextTenantCursor string
}

func (repo *Repo) stageTwoConversionWindow() time.Duration {
	if repo != nil && repo.StageTwoConversionWindow > 0 {
		return repo.StageTwoConversionWindow
	}
	return DefaultStageTwoConversionWindow
}

// stageTwoMethodologyVersion gives each stage its own methodology identity.
//
// This is not cosmetic and it is not a new classifier. event_classifications is
// unique on (event, classifier_version, methodology_version, registry_version,
// configuration_hash) and refuses a DIFFERENT result under the SAME identity —
// that refusal is what makes exact replays safe. A Stage-2 verdict is by
// definition a different result for the same event, because it is derived from
// a larger evidence window, so re-running the Stage-1 identity would either be a
// no-op or an idempotency conflict. Giving the stage its own methodology version
// makes the upgrade or downgrade an APPENDED row with supersedes_id pointing at
// the verdict it replaces: auditable, never an in-place overwrite. Re-running
// the same stage twice recomputes the identical row and is absorbed by the same
// uniqueness rule, which is where Stage 2's idempotence comes from.
func stageTwoMethodologyVersion(base string, stage StageTwoStage) (string, error) {
	var suffix string
	switch stage {
	case StageTwoDelayed:
		suffix = ".stage2-delayed"
	case StageTwoConversionWindowClose:
		suffix = ".stage2-window-close"
	default:
		return "", fmt.Errorf("%w: unknown stage two stage %q", ErrInvalidInput, stage)
	}
	version := base + suffix
	if !versionPattern.MatchString(version) {
		return "", fmt.Errorf("%w: stage two methodology version %q is invalid", ErrInvalidInput, version)
	}
	return version, nil
}

// stageTwoClassifier reuses the compiled registry and every calibrated weight of
// the production classifier. Only the methodology identity moves.
func stageTwoClassifier(base *Classifier, stage StageTwoStage) (*Classifier, error) {
	if base == nil {
		return nil, fmt.Errorf("%w: stage two requires the production classifier", ErrInvalidInput)
	}
	config := base.config
	version, err := stageTwoMethodologyVersion(config.MethodologyVersion, stage)
	if err != nil {
		return nil, err
	}
	config.MethodologyVersion = version
	return NewClassifier(config, base.registry)
}

// stageTwoRunRequestID derives the run identity from (tenant, message, stage),
// the EVENT WINDOW the run will cover, and the classifier identity that will
// perform the evaluation.
//
// THE INVARIANT: the id must cover exactly the material the request HASH covers,
// plus the scope that makes it unique. event_reclassification_runs is unique on
// (tenant, request_id) and createAndClaimRun refuses a row whose stored
// request_hash disagrees with the caller's — and reclassificationRequestHash
// mixes in the window start, the window end, the classifier version, the
// methodology version, the registry version and the configuration hash. Any
// field the hash reads and the id does not is an axis on which two genuinely
// different requests collapse onto one id and collide forever: the run row is
// immutable, so ErrIdempotencyConflict is the only possible outcome and no
// amount of retrying reconciles it.
//
// Both halves have been that bug.
//
//   - The CLASSIFIER half: an id derived from (tenant, message, stage) alone is
//     stable across a classifier configuration change while the hash is not, so
//     the next sweep to reach a message whose run was created under the previous
//     configuration conflicts. Because due_at never moves and the schedule row
//     stayed pending, that one message sat permanently at the head of its
//     tenant's due queue.
//
//   - The WINDOW half: claimStageTwoRun derives Start/End from the schedule
//     row's own first_event_at/due_at, and those are NOT constant for a
//     (tenant, message, stage) triple over time. A settled schedule row is
//     reaped by retention (migration 1967); a straggler event for the same
//     message then re-INSERTs the row with first_event_at set to the
//     straggler's observation time, so the window moves while an
//     id blind to the window does not. The re-armed evaluation conflicted with
//     the long-completed run and the straggler's evidence never received a
//     Stage-2 verdict at all — silently, because evaluate() reports a conflict
//     as a failed schedule row rather than a returned error, and permanently,
//     because event_reclassification_runs has no retention path so the stale
//     run outlives every future re-arm.
//
// Including both makes the id and the hash agree by construction: a different
// window or a different methodology asks for a NEW run rather than colliding
// with an old one, which is also the honest description of what it is — a
// different evidence window produces a different appended verdict, so it
// deserves its own auditable run. Mutual exclusion is untouched: two workers
// reaching the SAME schedule row read the same first_event_at/due_at and the
// same build, so they derive the same id and still contend for exactly one row.
//
// The window is formatted exactly as reclassificationRequestHash formats it —
// UTC, RFC3339Nano — so the two derivations cannot disagree about the same
// instant.
func stageTwoRunRequestID(
	tenantID, messageIdentityHash string,
	stage StageTwoStage,
	windowStart, windowEnd time.Time,
	classifier *Classifier,
) string {
	identity := ""
	if classifier != nil {
		identity = classifier.config.ClassifierVersion + "\x00" +
			classifier.config.MethodologyVersion + "\x00" +
			classifier.config.RegistryVersion + "\x00" + classifier.configHash
	}
	return uuid.NewSHA1(stageTwoRunNamespace, []byte(
		strings.TrimSpace(tenantID)+"\x00"+
			strings.TrimSpace(messageIdentityHash)+"\x00"+string(stage)+"\x00"+
			windowStart.UTC().Format(time.RFC3339Nano)+"\x00"+
			windowEnd.UTC().Format(time.RFC3339Nano)+"\x00"+
			identity,
	)).String()
}

// scheduleStageTwo arms both delayed moments for a message, exactly once.
//
// ON CONFLICT DO NOTHING is the whole mechanism for "60s after the FIRST event,
// not after each event": the first observation of a message writes the row, and
// every later observation for the same message is a no-op. A message receiving
// four hundred opens therefore schedules ONE delayed evaluation whose due time
// never slides, rather than four hundred, and rather than a timer that is pushed
// out by each new open and consequently never fires while traffic continues.
//
// It is a no-op for an observation with no message identity: without one there
// is no message to aggregate, so a delayed pass would re-read the same single
// row it already classified.
func scheduleStageTwo(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation ObservationInput,
	conversionWindow time.Duration,
) error {
	if tx == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("%w: stage two scheduling requires a tenant transaction", ErrInvalidInput)
	}
	if observation.MessageIdentityHash == "" {
		return nil
	}
	if observation.OccurredAt.IsZero() {
		return fmt.Errorf("%w: stage two scheduling requires occurred_at", ErrInvalidInput)
	}
	if conversionWindow < minimumStageTwoConversionWindow ||
		conversionWindow > maximumStageTwoConversionWindow {
		return fmt.Errorf("%w: stage two conversion window is outside 1h..90d", ErrInvalidInput)
	}
	firstEventAt := observation.OccurredAt.UTC()
	_, err := tx.Exec(ctx, `
INSERT INTO engagement_stage_two_evaluations (
    tenant_id, message_identity_hash, stage, first_event_at, due_at
) VALUES
    ($1::uuid, $2, 'delayed', $3, $4),
    ($1::uuid, $2, 'conversion_window_close', $3, $5)
ON CONFLICT (tenant_id, message_identity_hash, stage) DO NOTHING`,
		tenantID, observation.MessageIdentityHash, firstEventAt,
		firstEventAt.Add(StageTwoDelay), firstEventAt.Add(conversionWindow))
	if err != nil {
		return fmt.Errorf("schedule stage two evaluation: %w", err)
	}
	return nil
}

// DueStageTwoEvaluations reads the pending schedule rows whose moment has passed.
func (repo *Repo) DueStageTwoEvaluations(
	ctx context.Context,
	tenantID string,
	now time.Time,
	limit int,
) ([]StageTwoEvaluation, error) {
	if repo == nil || repo.Pool == nil || strings.TrimSpace(tenantID) == "" ||
		now.IsZero() || limit < 1 || limit > 1000 {
		return nil, fmt.Errorf("%w: invalid stage two due query", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("open stage two due transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT message_identity_hash, stage, first_event_at, due_at, state
  FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND state = 'pending' AND due_at <= $2
 ORDER BY due_at, message_identity_hash, stage
 LIMIT $3`, tenantID, now.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("query due stage two evaluations: %w", err)
	}
	defer rows.Close()
	out := make([]StageTwoEvaluation, 0, limit)
	for rows.Next() {
		evaluation := StageTwoEvaluation{TenantID: tenantID}
		if err := rows.Scan(&evaluation.MessageIdentityHash, &evaluation.Stage,
			&evaluation.FirstEventAt, &evaluation.DueAt, &evaluation.State); err != nil {
			return nil, fmt.Errorf("scan due stage two evaluation: %w", err)
		}
		out = append(out, evaluation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// claimStageTwoRun is the mutual-exclusion boundary.
//
// It does NOT introduce a lease. It derives a deterministic request id and hands
// the whole problem to event_reclassification_runs, which already owns a fenced
// lease with a steal-refusing database trigger. A second worker calling this for
// the same message gets ErrRunInProgress while the first one's lease is alive,
// and a run that has already completed reports itself completed instead of
// re-classifying.
func (repo *Repo) claimStageTwoRun(
	ctx context.Context,
	evaluation StageTwoEvaluation,
	classifier *Classifier,
) (ReclassificationRun, error) {
	if classifier == nil || !evaluation.Stage.Valid() ||
		strings.TrimSpace(evaluation.TenantID) == "" ||
		!hashPattern.MatchString(evaluation.MessageIdentityHash) ||
		evaluation.FirstEventAt.IsZero() ||
		!evaluation.DueAt.After(evaluation.FirstEventAt) {
		return ReclassificationRun{}, fmt.Errorf("%w: invalid stage two evaluation", ErrInvalidInput)
	}
	// The window is computed FIRST and then fed to both derivations, so the id
	// and the hash provably describe the same instants rather than two
	// independently recomputed views of them.
	window := ReclassificationWindow{
		Start: evaluation.FirstEventAt.UTC(),
		End:   evaluation.DueAt.UTC(),
	}
	window.RequestID = stageTwoRunRequestID(
		evaluation.TenantID, evaluation.MessageIdentityHash, evaluation.Stage,
		window.Start, window.End, classifier,
	)
	requestHash, err := reclassificationRequestHash(window, classifier)
	if err != nil {
		return ReclassificationRun{}, err
	}
	return repo.createAndClaimRun(ctx, evaluation.TenantID, window, classifier, requestHash)
}

// stageTwoMessageEvents lists the canonical events that share one message
// identity. This is the population whose verdicts the shape of the traffic can
// change; the reclassification window's own candidate query is time-based and
// would drag in unrelated messages.
func (repo *Repo) stageTwoMessageEvents(
	ctx context.Context,
	tenantID, messageIdentityHash string,
	limit int,
) ([]EventRef, error) {
	if repo == nil || repo.Pool == nil || strings.TrimSpace(tenantID) == "" ||
		!hashPattern.MatchString(messageIdentityHash) || limit < 1 ||
		limit > stageTwoMessageEventLimit {
		return nil, fmt.Errorf("%w: invalid stage two message event query", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("open stage two message transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT DISTINCT subscriber_event_at, subscriber_event_id
  FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2
 ORDER BY subscriber_event_at, subscriber_event_id
 LIMIT $3`, tenantID, messageIdentityHash, limit)
	if err != nil {
		return nil, fmt.Errorf("query stage two message events: %w", err)
	}
	defer rows.Close()
	out := make([]EventRef, 0, 8)
	for rows.Next() {
		var event EventRef
		if err := rows.Scan(&event.At, &event.ID); err != nil {
			return nil, fmt.Errorf("scan stage two message event: %w", err)
		}
		out = append(out, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (repo *Repo) completeStageTwoEvaluation(
	ctx context.Context,
	evaluation StageTwoEvaluation,
	runID string,
	evaluated, superseded, unchanged int64,
) error {
	if _, err := uuid.Parse(runID); err != nil {
		return fmt.Errorf("%w: stage two completion requires its run", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, evaluation.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return err
	}
	// state = 'pending' in the predicate makes the close idempotent: a worker
	// that raced and lost, or a retry after a crash between the run completing
	// and the schedule closing, updates zero rows and reports success rather
	// than trying to reopen a terminal row.
	if _, err := tx.Exec(ctx, `
UPDATE engagement_stage_two_evaluations
   SET state = 'completed', completed_at = clock_timestamp(),
       run_id = $4::uuid, evaluated_event_count = $5,
       superseded_count = $6, unchanged_count = $7
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2 AND stage = $3
   AND state = 'pending'`, evaluation.TenantID, evaluation.MessageIdentityHash,
		string(evaluation.Stage), runID, evaluated, superseded, unchanged); err != nil {
		return fmt.Errorf("complete stage two evaluation: %w", err)
	}
	return tx.Commit(ctx)
}

func (repo *Repo) failStageTwoEvaluation(
	ctx context.Context,
	evaluation StageTwoEvaluation,
	errorCode string,
) error {
	tx, err := db.WithTenantWorker(ctx, repo.Pool, evaluation.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE engagement_stage_two_evaluations
   SET state = 'failed', completed_at = clock_timestamp(), error_code = $4
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2 AND stage = $3
   AND state = 'pending'`, evaluation.TenantID, evaluation.MessageIdentityHash,
		string(evaluation.Stage), errorCode); err != nil {
		return fmt.Errorf("fail stage two evaluation: %w", err)
	}
	return tx.Commit(ctx)
}

// StageTwoWorker drains due evaluations. It owns no classification logic; every
// verdict it produces comes from Repo.reclassifyEvent under a real lease.
type StageTwoWorker struct {
	Repo             *Repo
	Classifier       *Classifier
	Interval         time.Duration
	TenantBatchSize  int
	MessageBatchSize int
	Logger           *slog.Logger
	Now              func() time.Time
}

func (worker *StageTwoWorker) now() time.Time {
	if worker != nil && worker.Now != nil {
		return worker.Now().UTC()
	}
	return time.Now().UTC()
}

func (worker *StageTwoWorker) validate() error {
	if worker == nil || worker.Repo == nil || worker.Repo.Pool == nil ||
		worker.Classifier == nil {
		return fmt.Errorf("%w: stage two worker requires a repository and classifier", ErrInvalidInput)
	}
	if worker.Interval < minimumStageTwoSweepInterval ||
		worker.Interval > maximumStageTwoSweepInterval ||
		worker.TenantBatchSize < 1 || worker.TenantBatchSize > 1000 ||
		worker.MessageBatchSize < 1 || worker.MessageBatchSize > 1000 {
		return fmt.Errorf("%w: stage two cadence or batch bound is invalid", ErrInvalidInput)
	}
	return nil
}

// EvaluateTenantOnce drains one page of due evaluations for one tenant.
//
// One failing message may not stop the page.
//
// The due query is ordered by due_at, so the oldest pending row is always
// examined first and an unrecoverable one is always examined FIRST AGAIN on the
// next sweep. Returning at the first error therefore does not merely lose one
// message: it parks the entire tenant behind that message permanently, silently,
// and with the backlog growing. Every message is attempted, the failures are
// counted, and the joined error is reported after the page rather than instead
// of it — a caller still learns that something failed, but a poisoned row can no
// longer starve the healthy ones behind it.
func (worker *StageTwoWorker) EvaluateTenantOnce(
	ctx context.Context,
	tenantID string,
) (StageTwoResult, error) {
	if err := worker.validate(); err != nil {
		return StageTwoResult{}, err
	}
	due, err := worker.Repo.DueStageTwoEvaluations(
		ctx, tenantID, worker.now(), worker.MessageBatchSize,
	)
	if err != nil {
		return StageTwoResult{}, err
	}
	result := StageTwoResult{}
	failures := make([]error, 0, 4)
	for _, evaluation := range due {
		result.Due++
		one, err := worker.evaluate(ctx, evaluation)
		result.add(one)
		if err == nil {
			continue
		}
		result.Failed++
		failures = append(failures, fmt.Errorf(
			"stage two message %s stage %s: %w",
			evaluation.MessageIdentityHash, evaluation.Stage, err,
		))
		// A cancelled or expired context is not this message's fault and every
		// remaining message would fail the same way; stop rather than burn the
		// page against a dead deadline.
		if ctx.Err() != nil {
			break
		}
	}
	return result, errors.Join(failures...)
}

// EvaluateMessage runs one specific scheduled evaluation on demand. It reads the
// schedule row rather than trusting the caller, so an unscheduled or already
// terminal message cannot be forced through the delay.
func (worker *StageTwoWorker) EvaluateMessage(
	ctx context.Context,
	tenantID, messageIdentityHash string,
	stage StageTwoStage,
) (StageTwoResult, error) {
	if err := worker.validate(); err != nil {
		return StageTwoResult{}, err
	}
	due, err := worker.Repo.DueStageTwoEvaluations(
		ctx, tenantID, worker.now(), 1000,
	)
	if err != nil {
		return StageTwoResult{}, err
	}
	for _, evaluation := range due {
		if evaluation.MessageIdentityHash != messageIdentityHash ||
			evaluation.Stage != stage {
			continue
		}
		result := StageTwoResult{Due: 1}
		one, err := worker.evaluate(ctx, evaluation)
		if err != nil {
			return result, err
		}
		result.add(one)
		return result, nil
	}
	return StageTwoResult{}, ErrStageTwoNotScheduled
}

func (worker *StageTwoWorker) evaluate(
	ctx context.Context,
	evaluation StageTwoEvaluation,
) (StageTwoResult, error) {
	result := StageTwoResult{}
	repo := worker.Repo
	classifier, err := stageTwoClassifier(worker.Classifier, evaluation.Stage)
	if err != nil {
		return result, err
	}
	run, err := repo.claimStageTwoRun(ctx, evaluation, classifier)
	switch {
	case errors.Is(err, ErrRunInProgress):
		// Another worker holds the live lease for this exact message and stage.
		// Leaving the schedule row pending is deliberate: the holder will close
		// it, and if the holder dies its lease expires and the next sweep
		// reclaims the same run at a higher attempt.
		result.LeaseHeldElsewhere++
		return result, nil
	case errors.Is(err, ErrRunTerminal):
		if err := repo.failStageTwoEvaluation(ctx, evaluation, "reclassification_run_terminal"); err != nil {
			return result, err
		}
		result.Failed++
		return result, nil
	case errors.Is(err, ErrIdempotencyConflict):
		// A run already exists for this exact request id whose recorded
		// request hash disagrees with the one this evaluation computes. No
		// amount of retrying reconciles that: the run row is immutable
		// evidence and the schedule row's due_at never moves, so leaving it
		// pending would re-present the same message at the head of this
		// tenant's queue on every sweep, forever. Record the conflict on the
		// schedule row so it becomes terminal, visible, and out of the way.
		if err := repo.failStageTwoEvaluation(ctx, evaluation, "reclassification_request_conflict"); err != nil {
			return result, err
		}
		result.Failed++
		return result, nil
	case err != nil:
		return result, fmt.Errorf("claim stage two run: %w", err)
	}
	if run.State == "completed" {
		// Durable proof this exact evaluation already happened. Close the
		// schedule from the run's own counters instead of classifying again.
		if err := repo.completeStageTwoEvaluation(ctx, evaluation, run.ID,
			run.CandidateCount, run.ClassifiedCount, run.UnchangedCount); err != nil {
			return result, err
		}
		result.AlreadyEvaluated++
		return result, nil
	}

	lease := leaseFromRun(run, repo.reclassificationLeaseTTL())
	events, err := repo.stageTwoMessageEvents(
		ctx, evaluation.TenantID, evaluation.MessageIdentityHash,
		stageTwoMessageEventLimit,
	)
	if err != nil {
		return result, worker.abandon(ctx, evaluation, run, lease, "message_load_failed", err)
	}
	var superseded, unchanged int64
	for _, event := range events {
		receipt, reclassifyErr := repo.reclassifyEvent(
			ctx, evaluation.TenantID, event, classifier, lease,
		)
		if reclassifyErr != nil {
			if errors.Is(reclassifyErr, ErrLeaseLost) {
				// The lease was reclaimed underneath us. The reclaiming worker is
				// now the owner; do not fail its run.
				result.LeaseHeldElsewhere++
				return result, nil
			}
			return result, worker.abandon(ctx, evaluation, run, lease, "classification_failed", reclassifyErr)
		}
		if receipt.ReclassificationRunID == run.ID {
			superseded++
		} else {
			unchanged++
		}
	}
	run.CandidateCount = int64(len(events))
	run.ClassifiedCount = superseded
	run.UnchangedCount = unchanged
	if _, err := repo.completeReclassificationRun(ctx, evaluation.TenantID, run, lease); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			result.LeaseHeldElsewhere++
			return result, nil
		}
		return result, fmt.Errorf("complete stage two run: %w", err)
	}
	if err := repo.completeStageTwoEvaluation(ctx, evaluation, run.ID,
		int64(len(events)), superseded, unchanged); err != nil {
		return result, err
	}
	result.Evaluated++
	result.EventsSuperseded += superseded
	result.EventsUnchanged += unchanged
	return result, nil
}

// abandon records the failure on both the run and the schedule row and returns
// the original cause. Marking only one of the two would leave a message that is
// permanently due against a run that can never be claimed again.
func (worker *StageTwoWorker) abandon(
	ctx context.Context,
	evaluation StageTwoEvaluation,
	run ReclassificationRun,
	lease reclassificationLease,
	errorCode string,
	cause error,
) error {
	run.ErrorCount++
	_, runErr := worker.Repo.failReclassificationRun(
		ctx, evaluation.TenantID, run, lease, errorCode, cause,
	)
	scheduleErr := worker.Repo.failStageTwoEvaluation(ctx, evaluation, errorCode)
	return errors.Join(runErr, scheduleErr)
}

// SweepOnce walks a bounded page of tenants and drains each one.
func (worker *StageTwoWorker) SweepOnce(
	ctx context.Context,
	afterTenantID string,
) (StageTwoSweepResult, error) {
	if err := worker.validate(); err != nil {
		return StageTwoSweepResult{}, err
	}
	afterTenantID = strings.TrimSpace(afterTenantID)
	if afterTenantID != "" {
		if _, err := uuid.Parse(afterTenantID); err != nil {
			return StageTwoSweepResult{}, fmt.Errorf("%w: stage two tenant cursor is invalid", ErrInvalidInput)
		}
	}
	tenants, err := worker.listTenantPage(ctx, afterTenantID)
	if err != nil {
		return StageTwoSweepResult{}, err
	}
	result := StageTwoSweepResult{}
	// One failing tenant may not stop the sweep either, for the same reason one
	// failing message may not stop a page: tenants are visited in a stable id
	// order, so aborting at the first error parks every tenant that sorts after
	// it behind a problem that is not theirs.
	failures := make([]error, 0, 4)
	for _, tenantID := range tenants {
		tenantResult, err := worker.EvaluateTenantOnce(ctx, tenantID)
		result.add(tenantResult)
		result.TenantCount++
		result.NextTenantCursor = tenantID
		if err != nil {
			failures = append(failures, fmt.Errorf("stage two sweep tenant %s: %w", tenantID, err))
			if ctx.Err() != nil {
				return result, errors.Join(failures...)
			}
		}
	}
	if len(tenants) < worker.TenantBatchSize {
		result.NextTenantCursor = ""
	}
	return result, errors.Join(failures...)
}

func (worker *StageTwoWorker) listTenantPage(
	ctx context.Context,
	afterTenantID string,
) ([]string, error) {
	tx, err := db.WithTenantResolver(ctx, worker.Repo.Pool)
	if err != nil {
		return nil, fmt.Errorf("open stage two tenant resolver: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM tenants
 WHERE ($1 = '' OR id::text > $1)
 ORDER BY id
 LIMIT $2`, afterTenantID, worker.TenantBatchSize)
	if err != nil {
		return nil, fmt.Errorf("list stage two tenants: %w", err)
	}
	defer rows.Close()
	tenants := make([]string, 0, worker.TenantBatchSize)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, fmt.Errorf("scan stage two tenant: %w", err)
		}
		tenants = append(tenants, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate stage two tenants: %w", err)
	}
	return tenants, nil
}

func (worker *StageTwoWorker) Run(ctx context.Context, logger *slog.Logger) error {
	if err := worker.validate(); err != nil {
		return err
	}
	if logger == nil {
		logger = worker.Logger
	}
	if logger == nil {
		logger = slog.Default()
	}
	cursor := ""
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			result, err := worker.SweepOnce(ctx, cursor)
			cursor = result.NextTenantCursor
			if err != nil {
				if errors.Is(err, context.Canceled) {
					return err
				}
				logger.Warn("engagement stage two sweep failed", "err", err)
			} else if result.Due > 0 {
				logger.Info("engagement stage two sweep completed",
					"tenant_count", result.TenantCount,
					"due", result.Due,
					"evaluated", result.Evaluated,
					"already_evaluated", result.AlreadyEvaluated,
					"lease_held_elsewhere", result.LeaseHeldElsewhere,
					"failed", result.Failed,
					"events_superseded", result.EventsSuperseded)
			}
			timer.Reset(worker.Interval)
		}
	}
}

// RunStageTwo drains the Stage-2 schedule for the lifetime of ctx.
func (runtime *Runtime) RunStageTwo(ctx context.Context, logger *slog.Logger) error {
	if runtime == nil || !runtime.enabled {
		return ErrRuntimeDisabled
	}
	if runtime.stageTwoWorker == nil {
		return ErrRuntimeNotReady
	}
	return runtime.stageTwoWorker.Run(ctx, logger)
}
