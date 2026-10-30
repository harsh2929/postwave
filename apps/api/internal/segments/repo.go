package segments

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

// Repo is the postgres-backed segment store. Every method opens its own
// tenant-scoped tx so RLS fires.
type Repo struct {
	Pool *db.Pool
}

// List returns all segments for the tenant in newest-first order.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Segment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, description, query_ast,
       last_count, last_evaluated_at, is_template, include_archived, folder_id::text, created_at, updated_at
FROM segments
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Segment{}
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Name, &s.Description,
			&s.QueryAST, &s.LastCount, &s.LastEvaluatedAt, &s.IsTemplate,
			&s.IncludeArchived, &s.FolderID, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Get fetches a segment by id, tenant-scoped.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Segment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var s Segment
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, query_ast,
       last_count, last_evaluated_at, is_template, include_archived, folder_id::text, created_at, updated_at
FROM segments WHERE id::text = $1`, id).
		Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.QueryAST,
			&s.LastCount, &s.LastEvaluatedAt, &s.IsTemplate, &s.IncludeArchived, &s.FolderID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// Create inserts a new segment.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Segment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// "" folderId is treated as unfiled, matching the PATCH tri-state.
	folder := in.FolderID
	if folder != nil && *folder == "" {
		folder = nil
	}
	s := &Segment{
		TenantID:        tenantID,
		Name:            in.Name,
		Description:     in.Description,
		QueryAST:        in.QueryAST,
		IsTemplate:      in.IsTemplate,
		IncludeArchived: in.IncludeArchived,
		FolderID:        folder,
	}
	err = tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, description, query_ast, is_template, include_archived, folder_id)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7::uuid)
RETURNING id::text, created_at, updated_at`,
		tenantID, in.Name, in.Description, []byte(in.QueryAST), in.IsTemplate, in.IncludeArchived, folder).
		Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrNameConflict
		}
		// Filing under a folder_id that isn't a segment_folders row for this
		// tenant trips the FK (SEG-038), mirroring saved segments.
		if isForeignKeyViolation(err) {
			return nil, ErrFolderNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Update applies the patch.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Segment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := r.getInTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		if in.IfMatchToken != httpcache.ConcurrencyToken("segment", cur.ID, cur.UpdatedAt) {
			return nil, ErrPreconditionFailed
		}
		ts := cur.UpdatedAt
		expectedUpdatedAt = &ts
	}
	if in.Name != nil {
		cur.Name = *in.Name
	}
	if in.Description != nil {
		cur.Description = *in.Description
	}
	includeArchivedBefore := cur.IncludeArchived
	if in.IncludeArchived != nil {
		cur.IncludeArchived = *in.IncludeArchived
	}
	// Folder tri-state (SEG-038): nil = unchanged; "" = unfile (NULL); id =
	// file. Resolve against the loaded row so the UPDATE can write folder_id
	// unconditionally from cur.FolderID.
	if in.FolderID != nil {
		if *in.FolderID == "" {
			cur.FolderID = nil
		} else {
			v := *in.FolderID
			cur.FolderID = &v
		}
	}
	// Detect a genuine definition change. When the predicate broadens, every
	// newly-matching subscriber would otherwise look like a fresh "entrant" to
	// the SegmentEventWorker and spuriously fire the segment_joined flow
	// trigger. Clearing membership_baseline_at makes the next cache rewrite
	// treat the redefinition as a first evaluation: it re-materialises the
	// cache without forwarding entry events, then resumes normal detection.
	astChanged := in.QueryAST != nil && string(*in.QueryAST) != string(cur.QueryAST)
	if in.QueryAST != nil {
		cur.QueryAST = *in.QueryAST
	}
	// The stored size describes the old definition or the old archive scope
	// once either changes, so it is cleared with the change rather than left
	// on the list as a stale number. The handler re-counts after the save.
	scopeChanged := astChanged || (in.IncludeArchived != nil && *in.IncludeArchived != includeArchivedBefore)
	if scopeChanged {
		cur.LastCount = nil
		cur.LastEvaluatedAt = nil
	}

	err = tx.QueryRow(ctx, `
UPDATE segments
   SET name=$1, description=$2, query_ast=$3::jsonb, include_archived=$7, folder_id=$8::uuid, updated_at=now(),
       membership_baseline_at = CASE WHEN $5 THEN NULL ELSE membership_baseline_at END,
       last_count = CASE WHEN $9 THEN NULL ELSE last_count END,
       last_evaluated_at = CASE WHEN $9 THEN NULL ELSE last_evaluated_at END
 WHERE id::text = $4
   AND ($6::timestamptz IS NULL OR updated_at = $6)
RETURNING updated_at`,
		cur.Name, cur.Description, []byte(cur.QueryAST), id, astChanged, expectedUpdatedAt, cur.IncludeArchived, cur.FolderID, scopeChanged).
		Scan(&cur.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) && expectedUpdatedAt != nil {
			return nil, ErrPreconditionFailed
		}
		if isUniqueViolation(err) {
			return nil, ErrNameConflict
		}
		// Re-filing under a folder_id that isn't a segment_folders row for the
		// tenant trips the FK (SEG-038).
		if isForeignKeyViolation(err) {
			return nil, ErrFolderNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cur, nil
}

// Delete removes a segment. While a campaign that has not sent yet targets the
// segment it refuses with a *SegmentInUseError naming those campaigns
// (errors.Is(err, ErrSegmentInUse)); deleting would retarget them at the whole
// workspace (migration 1876).
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM segments WHERE id::text = $1`, id)
	if err != nil {
		// The 1876 trigger decides whether the delete may go ahead, atomically
		// with the DELETE itself. Its refusal aborts the transaction, so the
		// campaigns are named from a fresh one rather than surfacing the
		// trigger's log-shaped text as a 500.
		if isSendableCampaignRefusal(err) {
			_ = tx.Rollback(ctx)
			return r.segmentInUseRefusal(ctx, tenantID, id)
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// segmentInUseRefusal names the campaigns that block a delete the trigger has
// refused. It always returns a refusal: when the blocking campaign moved away
// again in the meantime the refusal carries no names, and a retry will succeed.
func (r *Repo) segmentInUseRefusal(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	inUse := segmentInUse(ctx, tx, tenantID, id)
	if inUse == nil {
		return &SegmentInUseError{}
	}
	return inUse
}

// Count runs SELECT COUNT(*) FROM subscribers WHERE <fragment> against the
// tenant's subscribers table. Returns the count and the compiled SQL (for
// dev surfacing) or any compile/exec error.
func (r *Repo) Count(ctx context.Context, tenantID string, frag string, args []any) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := "SELECT COUNT(*) FROM subscribers WHERE " + frag
	var n int
	if err := tx.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ASTForSegment loads the stored query_ast of a segment, tenant-scoped,
// satisfying the SegmentResolver interface used by the composable
// segment-of-segments predicate (SUB-032). Returns ErrNotFound when the
// id is unknown for the tenant.
func (r *Repo) ASTForSegment(ctx context.Context, tenantID, segmentID string) (json.RawMessage, error) {
	seg, err := r.Get(ctx, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	return seg.QueryAST, nil
}

// CountWithWorkspaceTotal runs the predicate count and total-workspace
// subscriber count in a single tenant-scoped tx (SUB-030). It returns:
//
//   - count: subscribers matching <frag>;
//   - total: total subscribers in the saved view's archive scope (all
//     statuses) — the denominator for the workspace-percentage badge;
//
// One aggregate statement computes both values from one PostgreSQL statement
// snapshot. No member rows or identifiers are selected: the preview is an
// aggregate operation and has no reason to expose subscriber PII.
func (r *Repo) CountWithWorkspaceTotal(ctx context.Context, tenantID, frag string, args []any, includeArchived bool) (count, total int, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	totalFragment := "subscribers.archived_at IS NULL"
	if includeArchived {
		totalFragment = "TRUE"
	}
	query := "SELECT COUNT(*) FILTER (WHERE " + frag + "), " +
		"COUNT(*) FILTER (WHERE " + totalFragment + ") FROM subscribers"
	if err = tx.QueryRow(ctx, query, args...).Scan(&count, &total); err != nil {
		return 0, 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return count, total, nil
}

// CountSegmentAudience resolves segmentID to its compiled SQL predicate
// and returns the number of subscribers it matches. Used by the
// campaigns pre-send checklist + warmup-cap gate. This is explicitly an email
// activation count, not raw definition membership, so it is byte-for-byte
// aligned with campaign materialisation: enabled, non-archived, and consented.
// Unknown segments and evaluator errors fail closed.
func (r *Repo) CountSegmentAudience(ctx context.Context, tenantID, segmentID string) (int64, error) {
	if segmentID == "" {
		return 0, errors.New("segments: segment id is required for audience count")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	resolver := TransactionSegmentResolver{Queryer: tx}
	ast, err := resolver.ASTForSegment(ctx, tenantID, segmentID)
	if err != nil {
		return 0, err
	}
	predicate, err := CompilePopulation(ctx, ast, tenantID, resolver, ActivationPopulation(ActivationChannelEmail))
	if err != nil {
		return 0, err
	}
	var n int64
	if err := tx.QueryRow(ctx, "SELECT COUNT(*)::bigint FROM subscribers WHERE "+predicate.SQL, predicate.Args...).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

func (r *Repo) getInTx(ctx context.Context, tx pgx.Tx, id string) (*Segment, error) {
	var s Segment
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, query_ast,
       last_count, last_evaluated_at, is_template, include_archived, folder_id::text, created_at, updated_at
FROM segments WHERE id::text = $1`, id).
		Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.QueryAST,
			&s.LastCount, &s.LastEvaluatedAt, &s.IsTemplate, &s.IncludeArchived, &s.FolderID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &s, nil
}

func isUniqueViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}

// isForeignKeyViolation reports whether err is a Postgres foreign-key
// violation (SQLSTATE 23503) — e.g. filing a saved segment under a
// folder_id that does not exist for the tenant (SUB-040).
func isForeignKeyViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23503"
	}
	return false
}
