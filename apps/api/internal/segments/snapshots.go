// snapshots.go — GAP-LS-069: dynamic→static segment snapshot.
//
// HubSpot calls this "change list type"; Klaviyo AUD-04 captures
// the membership at a moment in time so an upcoming campaign can
// freeze its audience before the predicate drifts overnight.
//
// Two tables back this:
//
//   - segment_snapshots (0201): header row {id, tenant_id,
//     segment_id, query_ast, count, sample_subscribers,
//     evaluator_version, evaluated_at}. The pre-existing
//     Klaviyo-parity snapshot used as a sample/count cache.
//
// We INTENTIONALLY do NOT introduce a separate per-member join
// table here — the static-freeze flow (segment_static_freezes +
// segment_static_freeze_members in 0252) already serves the
// "freeze membership row-by-row" path. snapshots.go is the
// lighter cache-style snapshot: a count + a sampled list of
// emails materialized into the segment_snapshots row. The
// members endpoint paginates from that sample plus a re-runnable
// live evaluation against the snapshot's stored query_ast.
//
// Endpoints:
//
//   POST   /api/v1/segments/{id}/snapshot              create snapshot
//   GET    /api/v1/segments/{id}/snapshots             list snapshots
//   GET    /api/v1/segments/snapshots/{snapshot_id}/members  paginated members

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SnapshotMaxSampleSize caps the sampled-members projection. The
// actual member list is reachable via paginated re-evaluation.
const SnapshotMaxSampleSize = 500

// Snapshot is the public projection of a segment_snapshots row.
type Snapshot struct {
	ID               string          `json:"id"`
	TenantID         string          `json:"tenant_id"`
	SegmentID        string          `json:"segment_id"`
	QueryAST         json.RawMessage `json:"query_ast"`
	Count            int             `json:"count"`
	SampleSize       int             `json:"sample_size"`
	EvaluatorVersion string          `json:"evaluator_version"`
	EvaluatedAt      time.Time       `json:"evaluated_at"`
	CreatedAt        time.Time       `json:"created_at"`
}

// CreateSnapshot POST /api/v1/segments/{id}/snapshot — compiles the
// segment's current AST, counts, samples up to SnapshotMaxSampleSize
// emails, and writes the snapshot row. Returns snapshot_id.
func (d *Deps) CreateSnapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	seg, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Freeze the population the segment itself describes, archive scope
	// included, so a snapshot's count agrees with the segment's own size.
	predicate, err := CompilePopulation(r.Context(), seg.QueryAST, t.ID, d.Repo, DefinitionPopulation(seg.IncludeArchived))
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}
	snap, err := d.Repo.CreateSnapshot(r.Context(), t.ID, id, seg.QueryAST, predicate.SQL, predicate.Args)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, snap)
}

// ListSnapshots GET /api/v1/segments/{id}/snapshots — most-recent
// first.
func (d *Deps) ListSnapshots(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	out, err := d.Repo.ListSnapshots(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// SnapshotMember is one paginated row.
type SnapshotMember struct {
	Email        string `json:"email"`
	SubscriberID string `json:"subscriber_id"`
}

// SnapshotMembers GET /api/v1/segments/snapshots/{snapshot_id}/members
// — pages through the snapshot's sample_subscribers (cached at
// snapshot time). When the snapshot's actual member count exceeds
// the sample size we surface that gap in the response so the UI
// can warn "showing first N of M".
func (d *Deps) SnapshotMembers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	snapID := chi.URLParam(r, "snapshot_id")
	if snapID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "snapshot_id required"))
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page <= 0 {
		page = 1
	}
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	if perPage <= 0 || perPage > 200 {
		perPage = 50
	}
	members, total, sampleCount, err := d.Repo.SnapshotMembers(r.Context(), t.ID, snapID, page, perPage)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such snapshot"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":              members,
		"page":               page,
		"per_page":           perPage,
		"total":              total,
		"sample_size":        sampleCount,
		"sample_is_complete": sampleCount >= total,
	})
}

// --- repo layer ---

// CreateSnapshot evaluates the segment's compiled fragment, samples
// up to SnapshotMaxSampleSize emails into sample_subscribers, and
// inserts a row.
func (r *Repo) CreateSnapshot(ctx context.Context, tenantID, segmentID string, queryAST json.RawMessage, frag string, args []any) (*Snapshot, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var count int
	if err := tx.QueryRow(ctx, "SELECT COUNT(*) FROM subscribers WHERE "+frag, args...).Scan(&count); err != nil {
		return nil, fmt.Errorf("count: %w", err)
	}
	// Sample step: ORDER BY id keeps results stable across pages
	// when callers re-evaluate. LIMIT caps memory.
	sampleQuery := "SELECT id::text, email::text FROM subscribers WHERE " + frag + " ORDER BY id LIMIT " + strconv.Itoa(SnapshotMaxSampleSize)
	rows, err := tx.Query(ctx, sampleQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("sample: %w", err)
	}
	type sampleRow struct {
		ID    string `json:"subscriber_id"`
		Email string `json:"email"`
	}
	sample := make([]sampleRow, 0, SnapshotMaxSampleSize)
	for rows.Next() {
		var sr sampleRow
		if err := rows.Scan(&sr.ID, &sr.Email); err != nil {
			rows.Close()
			return nil, err
		}
		sample = append(sample, sr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sampleJSON, _ := json.Marshal(sample)
	if len(queryAST) == 0 {
		queryAST = json.RawMessage(`{}`)
	}

	snap := &Snapshot{
		TenantID:         tenantID,
		SegmentID:        segmentID,
		QueryAST:         queryAST,
		Count:            count,
		SampleSize:       len(sample),
		EvaluatorVersion: "segments.v1",
	}
	err = tx.QueryRow(ctx, `
INSERT INTO segment_snapshots (tenant_id, segment_id, query_ast, count, sample_subscribers, evaluator_version, evaluated_at)
VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5::jsonb, $6, now())
RETURNING id::text, evaluated_at, created_at`,
		tenantID, segmentID, []byte(queryAST), count, sampleJSON, snap.EvaluatorVersion).
		Scan(&snap.ID, &snap.EvaluatedAt, &snap.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return snap, nil
}

// ListSnapshots returns all snapshots for the given segment,
// newest first.
func (r *Repo) ListSnapshots(ctx context.Context, tenantID, segmentID string) ([]Snapshot, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(segment_id::text, ''), query_ast,
       count, jsonb_array_length(COALESCE(sample_subscribers, '[]'::jsonb)),
       evaluator_version, evaluated_at, created_at
FROM segment_snapshots
WHERE tenant_id = $1::uuid AND segment_id::text = $2
ORDER BY evaluated_at DESC, created_at DESC
LIMIT 100`, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Snapshot{}
	for rows.Next() {
		var s Snapshot
		if err := rows.Scan(&s.ID, &s.TenantID, &s.SegmentID, &s.QueryAST,
			&s.Count, &s.SampleSize, &s.EvaluatorVersion, &s.EvaluatedAt, &s.CreatedAt); err != nil {
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

// SnapshotMembers reads the snapshot's sampled member list and
// returns a slice of it. total is the snapshot's full count
// (which may exceed sampleCount).
func (r *Repo) SnapshotMembers(ctx context.Context, tenantID, snapshotID string, page, perPage int) ([]SnapshotMember, int, int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		sampleRaw []byte
		total     int
	)
	err = tx.QueryRow(ctx, `
SELECT COALESCE(sample_subscribers, '[]'::jsonb), count
FROM segment_snapshots
WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, snapshotID).
		Scan(&sampleRaw, &total)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, 0, ErrNotFound
		}
		return nil, 0, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, 0, err
	}
	var raw []struct {
		SubscriberID string `json:"subscriber_id"`
		Email        string `json:"email"`
	}
	if err := json.Unmarshal(sampleRaw, &raw); err != nil {
		raw = nil
	}
	sampleCount := len(raw)
	start := (page - 1) * perPage
	if start >= sampleCount {
		return []SnapshotMember{}, total, sampleCount, nil
	}
	end := start + perPage
	if end > sampleCount {
		end = sampleCount
	}
	out := make([]SnapshotMember, 0, end-start)
	for _, row := range raw[start:end] {
		out = append(out, SnapshotMember{Email: row.Email, SubscriberID: row.SubscriberID})
	}
	return out, total, sampleCount, nil
}
