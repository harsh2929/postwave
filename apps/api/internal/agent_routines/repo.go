// SPDX-License-Identifier: AGPL-3.0-only
//
// repo.go — pgx persistence for agent routines + runs. All
// tenant-scoped reads/writes go through db.WithTenant (RLS-bound);
// only scheduler candidate scans run cross-tenant under read-only
// db.WithWorkerScope policies; every claim/finalization write re-enters a
// tenant-scoped transaction.
package agent_routines

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo implements Store + RunnerStore on Postgres.
type Repo struct {
	Pool *db.Pool
	// dueCandidateScan is an unexported deterministic seam for database race
	// tests. Production constructors leave it nil, so ClaimDue always performs
	// the cross-tenant, read-only worker/RLS scan below.
	dueCandidateScan func(context.Context, int) ([]DueRoutine, error)
	// staleRunScan provides the equivalent fixture-only discovery seam for
	// FailStaleRuns. It is nil in production.
	staleRunScan func(context.Context, time.Time, int) ([]staleRunCandidate, error)
}

// ErrRunNotRunning protects terminal receipts from late writers. It covers a
// missing run and a run already finalized by either Execute or stale recovery;
// callers intentionally cannot distinguish those states across a tenant
// boundary.
var ErrRunNotRunning = errors.New("agent_routines: run is not active")

// Store is the handler-facing persistence surface. Implemented by
// *Repo; handler tests pass a fake.
type Store interface {
	CreateRoutine(ctx context.Context, tenantID string, in CreateInput, createdBy string) (*Routine, error)
	ListRoutines(ctx context.Context, tenantID string) ([]Routine, error)
	GetRoutine(ctx context.Context, tenantID, id string) (*Routine, error)
	UpdateRoutine(ctx context.Context, tenantID, id string, in UpdateInput) (*Routine, error)
	DeleteRoutine(ctx context.Context, tenantID, id string) error
	ListRuns(ctx context.Context, tenantID, routineID string, limit int) ([]Run, error)
	// GetRunByApproval returns the run that opened a given approval (for
	// the Approvals trust panel). ErrNotFound when none references it.
	GetRunByApproval(ctx context.Context, tenantID, approvalID string) (*Run, error)
}

const routineColumns = `
id::text, name, prompt, kind, schedule, schedule_detail,
target_list_id::text, target_segment_id::text,
require_approval, enabled, last_run_at, COALESCE(created_by, ''),
created_at, updated_at`

const routineActiveColumn = `,
EXISTS (
    SELECT 1
      FROM agent_routine_runs active_run
     WHERE active_run.tenant_id = agent_routines.tenant_id
       AND active_run.routine_id = agent_routines.id
       AND active_run.status = 'running'
)`

func scanRoutine(row pgx.Row) (*Routine, error) {
	var rt Routine
	var detailRaw []byte
	if err := row.Scan(&rt.ID, &rt.Name, &rt.Prompt, &rt.Kind, &rt.Schedule, &detailRaw,
		&rt.TargetListID, &rt.TargetSegmentID,
		&rt.RequireApproval, &rt.Enabled, &rt.LastRunAt, &rt.CreatedBy,
		&rt.CreatedAt, &rt.UpdatedAt); err != nil {
		return nil, err
	}
	if len(detailRaw) > 0 {
		_ = json.Unmarshal(detailRaw, &rt.ScheduleDetail)
	}
	return &rt, nil
}

func scanRoutineWithActive(row pgx.Row) (*Routine, error) {
	var rt Routine
	var detailRaw []byte
	if err := row.Scan(&rt.ID, &rt.Name, &rt.Prompt, &rt.Kind, &rt.Schedule, &detailRaw,
		&rt.TargetListID, &rt.TargetSegmentID,
		&rt.RequireApproval, &rt.Enabled, &rt.LastRunAt, &rt.CreatedBy,
		&rt.CreatedAt, &rt.UpdatedAt, &rt.HasActiveRun); err != nil {
		return nil, err
	}
	if len(detailRaw) > 0 {
		_ = json.Unmarshal(detailRaw, &rt.ScheduleDetail)
	}
	return &rt, nil
}

// CreateRoutine inserts a routine. require_approval defaults to TRUE
// when absent (the safe default — agent output stays gated).
func (r *Repo) CreateRoutine(ctx context.Context, tenantID string, in CreateInput, createdBy string) (*Routine, error) {
	if err := validateTargetListInput(in.TargetListID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	targetListID := strings.TrimSpace(deref(in.TargetListID))
	targetSegmentID := strings.TrimSpace(deref(in.TargetSegmentID))
	if err := lockOwnedTargetSegment(ctx, tx, tenantID, targetSegmentID); err != nil {
		return nil, err
	}
	requireApproval := true
	if in.RequireApproval != nil {
		requireApproval = *in.RequireApproval
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	detailRaw, _ := json.Marshal(nonNilDetail(in.ScheduleDetail))
	row := tx.QueryRow(ctx, `
INSERT INTO agent_routines (
    tenant_id, name, prompt, kind, schedule, schedule_detail,
    target_list_id, target_segment_id, require_approval, enabled, created_by
)
VALUES (
    $1::uuid, $2, $3, $4, $5, $6::jsonb,
    NULLIF($7, '')::uuid, NULLIF($8, '')::uuid, $9, $10, NULLIF($11, '')
)
RETURNING `+routineColumns,
		tenantID, in.Name, in.Prompt, in.Kind, in.Schedule, string(detailRaw),
		targetListID, targetSegmentID, requireApproval, enabled, createdBy)
	rt, err := scanRoutine(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrNameTaken
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return rt, nil
}

// ListRoutines returns the tenant's routines, newest-first.
func (r *Repo) ListRoutines(ctx context.Context, tenantID string) ([]Routine, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+routineColumns+routineActiveColumn+`
  FROM agent_routines
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Routine{}
	for rows.Next() {
		rt, err := scanRoutineWithActive(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetRoutine fetches one routine.
func (r *Repo) GetRoutine(ctx context.Context, tenantID, id string) (*Routine, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rt, err := scanRoutineWithActive(tx.QueryRow(ctx, `
SELECT `+routineColumns+routineActiveColumn+`
  FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return rt, nil
}

// UpdateRoutine patches the supplied fields.
func (r *Repo) UpdateRoutine(ctx context.Context, tenantID, id string, in UpdateInput) (*Routine, error) {
	if err := validateTargetListInput(in.TargetListID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// A requested target is locked before the routine row. PostgreSQL's
	// ON DELETE SET NULL action takes locks in that same segment -> routine
	// order, so matching it avoids a delete/update deadlock. An unchanged
	// target needs no new ownership check: the composite FK is the durable
	// invariant, and any concurrent SET NULL action serializes on the routine.
	if in.TargetSegmentID != nil {
		var existingID string
		err := tx.QueryRow(ctx, `
SELECT id::text
  FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(&existingID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if err := lockOwnedTargetSegment(ctx, tx, tenantID, *in.TargetSegmentID); err != nil {
			return nil, err
		}
	}
	cur, err := scanRoutine(tx.QueryRow(ctx, `
SELECT `+routineColumns+`
  FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2
 FOR UPDATE`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	active, err := routineHasActiveRun(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if active {
		return nil, ErrRoutineActive
	}
	if in.Name != nil {
		cur.Name = *in.Name
	}
	if in.Prompt != nil {
		cur.Prompt = *in.Prompt
	}
	if in.Schedule != nil {
		cur.Schedule = *in.Schedule
	}
	if in.ScheduleDetail != nil {
		cur.ScheduleDetail = *in.ScheduleDetail
	}
	if in.TargetListID != nil {
		cur.TargetListID = nilIfEmpty(*in.TargetListID)
	}
	if in.TargetSegmentID != nil {
		cur.TargetSegmentID = nilIfEmpty(*in.TargetSegmentID)
	}
	if in.RequireApproval != nil {
		cur.RequireApproval = *in.RequireApproval
	}
	if in.Enabled != nil {
		cur.Enabled = *in.Enabled
	}
	targetListID := strings.TrimSpace(deref(cur.TargetListID))
	targetSegmentID := strings.TrimSpace(deref(cur.TargetSegmentID))
	detailRaw, _ := json.Marshal(nonNilDetail(cur.ScheduleDetail))
	row := tx.QueryRow(ctx, `
UPDATE agent_routines
   SET name = $3, prompt = $4, schedule = $5, schedule_detail = $6::jsonb,
       target_list_id = NULLIF($7, '')::uuid,
       target_segment_id = NULLIF($8, '')::uuid,
       require_approval = $9, enabled = $10, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING `+routineColumns,
		tenantID, id, cur.Name, cur.Prompt, cur.Schedule, string(detailRaw),
		targetListID, targetSegmentID, cur.RequireApproval, cur.Enabled)
	rt, err := scanRoutine(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrNameTaken
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return rt, nil
}

// lockOwnedTargetSegment verifies the optional canonical segment under the
// same RLS-bound transaction that writes the routine. FOR KEY SHARE closes the
// delete-between-check-and-write race: a concurrent DELETE either commits
// first (this returns ErrInvalidTargetSegment) or waits until this routine
// write commits, after which the FK's ON DELETE SET NULL behavior is safe.
func lockOwnedTargetSegment(ctx context.Context, tx pgx.Tx, tenantID, targetID string) error {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return nil
	}
	if _, err := uuid.Parse(targetID); err != nil {
		return ErrInvalidTargetSegment
	}
	var id string
	err := tx.QueryRow(ctx, `
SELECT id::text
  FROM segments
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR KEY SHARE`, tenantID, targetID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalidTargetSegment
	}
	return err
}

// DeleteRoutine removes an idle routine. The routine row lock serializes with
// both manual Start and scheduler claims; once either path has opened a
// running receipt, deletion fails closed so ON DELETE CASCADE cannot erase the
// detached execution's ledger while model work is still in flight.
func (r *Repo) DeleteRoutine(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var lockedID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2
 FOR UPDATE`, tenantID, id).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	active, err := routineHasActiveRun(ctx, tx, tenantID, lockedID)
	if err != nil {
		return err
	}
	if active {
		return ErrRoutineActive
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func routineHasActiveRun(ctx context.Context, tx pgx.Tx, tenantID, routineID string) (bool, error) {
	var active bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM agent_routine_runs
     WHERE tenant_id = $1::uuid
       AND routine_id::text = $2
       AND status = 'running'
)`, tenantID, routineID).Scan(&active)
	return active, err
}

// ListRuns returns a routine's recent runs, newest-first.
func (r *Repo) ListRuns(ctx context.Context, tenantID, routineID string, limit int) ([]Run, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+runColumns+`
  FROM agent_routine_runs
 WHERE tenant_id = $1::uuid AND routine_id::text = $2
 ORDER BY started_at DESC
 LIMIT $3`, tenantID, routineID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// runColumns is the shared run projection (ListRuns + GetRunByApproval).
const runColumns = `
id::text, routine_id::text, status,
COALESCE(output_kind, ''), COALESCE(output_ref, ''),
COALESCE(approval_id, ''), COALESCE(error, ''),
COALESCE(prompt_used, ''), COALESCE(context_used, ''),
COALESCE(reasoning, ''), draft_preview,
started_at, finished_at`

func scanRun(row pgx.Row) (Run, error) {
	var run Run
	var preview []byte
	if err := row.Scan(&run.ID, &run.RoutineID, &run.Status,
		&run.OutputKind, &run.OutputRef, &run.ApprovalID, &run.Error,
		&run.PromptUsed, &run.ContextUsed, &run.Reasoning, &preview,
		&run.StartedAt, &run.FinishedAt); err != nil {
		return Run{}, err
	}
	if len(preview) > 0 {
		run.DraftPreview = json.RawMessage(preview)
	}
	return run, nil
}

// GetRunByApproval returns the run that opened a given approval, so the
// Approvals surface can show the agent's reasoning + draft snapshot
// alongside the decision. Returns ErrNotFound when no run references the
// approval (e.g. a non-agent approval).
func (r *Repo) GetRunByApproval(ctx context.Context, tenantID, approvalID string) (*Run, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM agent_routine_runs
 WHERE tenant_id = $1::uuid AND approval_id = $2
 ORDER BY started_at DESC
 LIMIT 1`, tenantID, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

// InsertRun implements RunnerStore: one tx opens the 'running' ledger
// row and stamps last_run_at so the due-scan stops re-selecting the
// routine immediately.
func (r *Repo) InsertRun(ctx context.Context, tenantID, routineID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var lockedID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM agent_routines
 WHERE tenant_id = $1::uuid AND id::text = $2
 FOR UPDATE`, tenantID, routineID).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	active, err := routineHasActiveRun(ctx, tx, tenantID, lockedID)
	if err != nil {
		return "", err
	}
	if active {
		return "", ErrRoutineActive
	}
	if _, err := tx.Exec(ctx, `
UPDATE agent_routines SET last_run_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, lockedID); err != nil {
		if isRoutineActiveViolation(err) {
			return "", ErrRoutineActive
		}
		return "", err
	}
	var runID string
	err = tx.QueryRow(ctx, `
INSERT INTO agent_routine_runs (tenant_id, routine_id, status)
VALUES ($1::uuid, $2::uuid, 'running')
RETURNING id::text`, tenantID, lockedID).Scan(&runID)
	if err != nil {
		if isRoutineActiveViolation(err) {
			return "", ErrRoutineActive
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return runID, nil
}

// FinishRun implements RunnerStore. Writes the terminal status plus the
// trust record (prompt/context/reasoning/draft snapshot). A nil
// DraftPreview is stored as SQL NULL, not an empty jsonb.
func (r *Repo) FinishRun(ctx context.Context, tenantID, runID string, in FinishRunInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var preview *string
	if len(in.DraftPreview) > 0 {
		s := string(in.DraftPreview)
		preview = &s
	}
	tag, err := tx.Exec(ctx, `
UPDATE agent_routine_runs
   SET status = $3,
       output_kind   = NULLIF($4, ''),
       output_ref    = NULLIF($5, ''),
       approval_id   = NULLIF($6, ''),
       error         = NULLIF($7, ''),
       prompt_used   = NULLIF($8, ''),
       context_used  = NULLIF($9, ''),
       reasoning     = NULLIF($10, ''),
       draft_preview = $11::jsonb,
       finished_at   = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status = 'running'`,
		tenantID, runID, in.Status, in.OutputKind, in.OutputRef, in.ApprovalID, in.ErrMsg,
		in.PromptUsed, in.ContextUsed, in.Reasoning, preview)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrRunNotRunning
	}
	return tx.Commit(ctx)
}

// CreateDraftCampaign implements RunnerStore: inserts a status='draft'
// campaign owned by apps/api. The status literal is the never-auto-send
// guarantee — this is the ONLY campaign write in the package.
func (r *Repo) CreateDraftCampaign(ctx context.Context, tenantID string, d CampaignDraft, segmentID *string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, preview_text, segment_id)
VALUES ($1::uuid, $2, $3, 'draft', NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, '')::uuid)
RETURNING id::text`,
		tenantID, d.Name, d.Subject, d.Body, d.PreviewText, deref(segmentID)).Scan(&id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// DueRoutine is one durably claimed scheduled run. RunID is created in the
// same transaction that stamps last_run_at; the run receipt (not last_run_at)
// is the authoritative success/failure record for the attempt.
type DueRoutine struct {
	RoutineID string
	TenantID  string
	RunID     string
}

const schedulerClaimMaxBatch = 100

// ClaimDue scans under the narrow worker SELECT policy, then atomically claims
// candidates through a tenant-scoped compare-and-set UPDATE. Concurrent
// replicas may observe the same candidate, but PostgreSQL re-checks the due
// predicate after the row lock is acquired: exactly one transaction advances
// last_run_at and creates the durable running receipt; every loser sees zero
// updated rows. This avoids granting the worker cross-tenant UPDATE authority.
func (r *Repo) ClaimDue(ctx context.Context, limit int) ([]DueRoutine, error) {
	if limit <= 0 {
		return []DueRoutine{}, nil
	}
	if limit > schedulerClaimMaxBatch {
		limit = schedulerClaimMaxBatch
	}
	candidateLimit := limit * 4
	if candidateLimit > schedulerClaimMaxBatch {
		candidateLimit = schedulerClaimMaxBatch
	}
	candidates, err := r.scanDueCandidates(ctx, candidateLimit)
	if err != nil {
		return nil, err
	}

	claimed := make([]DueRoutine, 0, limit)
	for _, candidate := range candidates {
		runID, won, err := r.claimDueRoutine(ctx, candidate.TenantID, candidate.RoutineID)
		if err != nil {
			return claimed, err
		}
		if !won {
			continue
		}
		candidate.RunID = runID
		claimed = append(claimed, candidate)
		if len(claimed) == limit {
			break
		}
	}
	return claimed, nil
}

func (r *Repo) scanDueCandidates(ctx context.Context, candidateLimit int) ([]DueRoutine, error) {
	if r.dueCandidateScan != nil {
		return r.dueCandidateScan(ctx, candidateLimit)
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text
  FROM agent_routines
 WHERE enabled
   AND schedule <> 'manual'
   AND NOT EXISTS (
       SELECT 1
         FROM agent_routine_runs active_run
        WHERE active_run.tenant_id = agent_routines.tenant_id
          AND active_run.routine_id = agent_routines.id
          AND active_run.status = 'running'
   )
   AND (
         last_run_at IS NULL
      OR (schedule = 'daily'   AND last_run_at <= now() - interval '24 hours')
      OR (schedule = 'weekly'  AND last_run_at <= now() - interval '7 days')
      OR (schedule = 'monthly' AND last_run_at <= now() - interval '30 days')
   )
 ORDER BY last_run_at ASC NULLS FIRST
 LIMIT $1`, candidateLimit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	candidates := []DueRoutine{}
	for rows.Next() {
		var d DueRoutine
		if err := rows.Scan(&d.RoutineID, &d.TenantID); err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return nil, err
		}
		candidates = append(candidates, d)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		_ = tx.Rollback(ctx)
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (r *Repo) claimDueRoutine(ctx context.Context, tenantID, routineID string) (string, bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedID string
	err = tx.QueryRow(ctx, `
UPDATE agent_routines
   SET last_run_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND enabled
   AND schedule <> 'manual'
   AND NOT EXISTS (
       SELECT 1
         FROM agent_routine_runs active_run
        WHERE active_run.tenant_id = agent_routines.tenant_id
          AND active_run.routine_id = agent_routines.id
          AND active_run.status = 'running'
   )
   AND (
         last_run_at IS NULL
      OR (schedule = 'daily'   AND last_run_at <= now() - interval '24 hours')
      OR (schedule = 'weekly'  AND last_run_at <= now() - interval '7 days')
      OR (schedule = 'monthly' AND last_run_at <= now() - interval '30 days')
   )
RETURNING id::text`, tenantID, routineID).Scan(&claimedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if isRoutineActiveViolation(err) {
			return "", false, nil
		}
		return "", false, err
	}
	var runID string
	if err := tx.QueryRow(ctx, `
INSERT INTO agent_routine_runs (tenant_id, routine_id, status)
VALUES ($1::uuid, $2::uuid, 'running')
RETURNING id::text`, tenantID, claimedID).Scan(&runID); err != nil {
		if isRoutineActiveViolation(err) {
			return "", false, nil
		}
		return "", false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return runID, true, nil
}

// FailStaleRuns terminalizes abandoned running receipts without replaying
// their work. Re-executing an LLM call after a process crash could duplicate a
// draft or approval if the crash happened after the side effect but before
// FinishRun, so recovery is deliberately ledger-only.
func (r *Repo) FailStaleRuns(ctx context.Context, startedBefore time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	if limit > schedulerClaimMaxBatch {
		limit = schedulerClaimMaxBatch
	}
	stale, err := r.scanStaleRuns(ctx, startedBefore, limit)
	if err != nil {
		return 0, err
	}

	finalized := 0
	for _, run := range stale {
		changed, err := r.failStaleRun(ctx, run.tenantID, run.id, startedBefore)
		if err != nil {
			return finalized, err
		}
		if changed {
			finalized++
		}
	}
	return finalized, nil
}

type staleRunCandidate struct {
	id       string
	tenantID string
}

func (r *Repo) scanStaleRuns(ctx context.Context, startedBefore time.Time, limit int) ([]staleRunCandidate, error) {
	if r.staleRunScan != nil {
		return r.staleRunScan(ctx, startedBefore, limit)
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text
 FROM agent_routine_runs
 WHERE status = 'running' AND started_at < $1
 ORDER BY started_at ASC
 LIMIT $2`, startedBefore, limit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	stale := make([]staleRunCandidate, 0, limit)
	for rows.Next() {
		var run staleRunCandidate
		if err := rows.Scan(&run.id, &run.tenantID); err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return nil, err
		}
		stale = append(stale, run)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		_ = tx.Rollback(ctx)
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return stale, nil
}

func (r *Repo) failStaleRun(ctx context.Context, tenantID, runID string, startedBefore time.Time) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE agent_routine_runs
   SET status = 'failed',
       error = $3,
       finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status = 'running' AND started_at < $4`,
		tenantID, runID, staleRunInterruptedError, startedBefore)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nilIfEmpty(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func nonNilDetail(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// isUniqueViolation reports a typed Postgres unique-constraint violation.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isRoutineActiveViolation(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.ConstraintName {
	case "agent_routine_runs_one_active_idx",
		"agent_routine_runs_one_active_guard",
		"agent_routines_active_run_guard":
		return true
	default:
		return false
	}
}
