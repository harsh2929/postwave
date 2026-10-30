// SPDX-License-Identifier: AGPL-3.0-only
//
// evaluation.go — last_count / last_evaluated_at, the size a segment shows.
//
// These two columns are display state: "how many subscribers match, as of
// when". Every writer counts under the segment's own archive scope
// (include_archived), and every writer records the count only for the
// definition version it counted, identified by updated_at, so a count of an old
// definition can never land on a new one. Whether the membership cache holds a
// baseline is a different question with its own column (membership_baseline_at,
// see membership_cache.go).
//
// A segment is evaluated when it is saved, so a new segment arrives on the
// list and its overview already counted instead of reading "—" and "Never"
// until the next hourly snapshot.

package segments

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// saveEvaluationTimeout bounds the count a save runs. Saving must not wait on a
// slow count: past this the segment is returned uncounted, and the next
// recompute or daily snapshot counts it.
const saveEvaluationTimeout = 3 * time.Second

// saveRecordTimeout bounds recording that count. The UPDATE queues behind any
// transaction holding the segment's row, and the save's response must not.
const saveRecordTimeout = time.Second

// RecordEvaluation stores count as the segment's size for the definition
// version identified by definitionVersion (the updated_at the count was taken
// against). It returns the evaluation instant, or nil when the segment has been
// redefined or deleted since: the count describes a definition that no longer
// exists, so nothing is written.
func (r *Repo) RecordEvaluation(ctx context.Context, tenantID, id string, definitionVersion time.Time, count int) (*time.Time, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	at, err := recordEvaluationInTx(ctx, tx, tenantID, id, definitionVersion, count)
	if err != nil || at == nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return at, nil
}

// recordEvaluationInTx is RecordEvaluation inside the caller's transaction. An
// evaluation is not an edit, so updated_at (and with it the segment's ETag) is
// left alone.
func recordEvaluationInTx(ctx context.Context, tx pgx.Tx, tenantID, id string, definitionVersion time.Time, count int) (*time.Time, error) {
	var at time.Time
	err := tx.QueryRow(ctx, `
UPDATE segments
   SET last_count = $3, last_evaluated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND updated_at = $4
RETURNING last_evaluated_at`, tenantID, id, count, definitionVersion).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &at, nil
}

// evaluateSaved counts a segment that was just created or redefined and
// records the result on s as well as in the database. It is best-effort by
// design: the save has already committed, so a slow or failing count is logged
// and the segment is returned uncounted rather than failing the request.
func (d *Deps) evaluateSaved(ctx context.Context, tenantID string, s *Segment) {
	n, at, err := d.countAndRecord(ctx, tenantID, s)
	if err != nil {
		d.logger().Warn("segments: saved segment left uncounted",
			"tenant_id", tenantID, "segment_id", s.ID, "err", err)
		return
	}
	if at == nil {
		// Redefined by a concurrent save, which counts its own version.
		return
	}
	s.LastCount = &n
	s.LastEvaluatedAt = at
}

// countAndRecord counts s under its own archive scope within
// saveEvaluationTimeout and records the count against the version of s that
// was counted within saveRecordTimeout.
func (d *Deps) countAndRecord(ctx context.Context, tenantID string, s *Segment) (int, *time.Time, error) {
	countCtx, cancelCount := context.WithTimeout(ctx, saveEvaluationTimeout)
	defer cancelCount()
	predicate, err := CompilePopulation(countCtx, s.QueryAST, tenantID, d.Repo, DefinitionPopulation(s.IncludeArchived))
	if err != nil {
		return 0, nil, err
	}
	n, err := d.Repo.Count(countCtx, tenantID, predicate.SQL, predicate.Args)
	if err != nil {
		return 0, nil, err
	}
	recordCtx, cancelRecord := context.WithTimeout(ctx, saveRecordTimeout)
	defer cancelRecord()
	at, err := d.Repo.RecordEvaluation(recordCtx, tenantID, s.ID, s.UpdatedAt, n)
	return n, at, err
}

func (d *Deps) logger() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}
