// size_history.go — GAP-LS-081: "segment size over time" graph.
//
// HubSpot exposes a 90-day size-over-time line for every list and segment.
// Moosewave persists the same series in segment_size_history (migration 0392),
// populated by SnapshotWorker. A newly-created segment with no snapshots yet
// receives one live point so the chart has an honest initial state. The
// undefined-table fallback exists only for a rolling deploy in which the API
// reaches a database before migration 0392; other database failures must fail
// the request rather than masquerading as an empty history.

package segments

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The note travels with a single live point, and the web, desktop and mobile
// clients all render it verbatim under the chart, so it is written for the
// person reading the chart, not for the operator reading a log.
const (
	sizeHistoryNotStartedNote  = "No daily sizes have been recorded for this segment yet, so this is its current size. A size is recorded once a day from now on."
	sizeHistoryUnavailableNote = "Size history is temporarily unavailable, so this is the segment's current size only."
)

// SizeHistoryPoint is one point on the size-over-time series.
type SizeHistoryPoint struct {
	EvaluatedAt time.Time `json:"evaluated_at"`
	Count       int       `json:"count"`
}

// SizeHistoryResponse is the wire shape.
type SizeHistoryResponse struct {
	SegmentID  string             `json:"segment_id"`
	WindowDays int                `json:"window_days"`
	Series     []SizeHistoryPoint `json:"series"`
	Note       string             `json:"note,omitempty"`
}

// SegmentSizeHistory GET /api/v1/segments/{id}/size-history?window=90d.
func (d *Deps) SegmentSizeHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "segment id required")
		return
	}
	window := parseWindowDays(r.URL.Query().Get("window"))

	resp, err := d.Repo.SegmentSizeHistory(r.Context(), t.ID, id, window)
	if err != nil {
		// A segment that does not exist is a 404, not a server failure. The
		// package already carries the sentinel; nothing was reading it here, so
		// asking for any absent segment id answered 500.
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "segment not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// SegmentSizeHistory reads the persisted series and computes a single live
// point only when the segment is new or a rolling deployment has not applied
// migration 0392 yet.
func (r *Repo) SegmentSizeHistory(ctx context.Context, tenantID, segmentID string, windowDays int) (*SizeHistoryResponse, error) {
	out := &SizeHistoryResponse{
		SegmentID:  segmentID,
		WindowDays: windowDays,
		Series:     []SizeHistoryPoint{},
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Optimistic SELECT from segment_size_history. The pgconn
	// 42P01 error code is "undefined table" — when we see it we
	// fall through to the live count path. We do NOT keep the
	// transaction open after that error (would be in failed-tx
	// state); commit and reopen.
	rows, err := tx.Query(ctx, `
SELECT evaluated_at, count
FROM segment_size_history
WHERE tenant_id = $1::uuid AND segment_id::text = $2
  AND evaluated_at >= now() - $3::int * interval '1 day'
ORDER BY evaluated_at ASC`, tenantID, segmentID, windowDays)
	if err != nil {
		_ = tx.Rollback(ctx)
		if isUndefinedTable(err) {
			out.Note = sizeHistoryUnavailableNote
			return r.fallbackLiveSizePoint(ctx, tenantID, segmentID, out)
		}
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p SizeHistoryPoint
		if err := rows.Scan(&p.EvaluatedAt, &p.Count); err != nil {
			return nil, err
		}
		out.Series = append(out.Series, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// If no history yet (table exists but empty), append a single
	// live point so the chart renders something.
	if len(out.Series) == 0 {
		out.Note = sizeHistoryNotStartedNote
		return r.fallbackLiveSizePoint(ctx, tenantID, segmentID, out)
	}
	return out, nil
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func (r *Repo) fallbackLiveSizePoint(ctx context.Context, tenantID, segmentID string, out *SizeHistoryResponse) (*SizeHistoryResponse, error) {
	seg, err := r.Get(ctx, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	// The same archive scope the persisted series is counted under, so the
	// live point joins the line instead of jumping off it.
	predicate, err := CompilePopulation(ctx, seg.QueryAST, tenantID, r, DefinitionPopulation(seg.IncludeArchived))
	if err != nil {
		return nil, err
	}
	n, err := r.Count(ctx, tenantID, predicate.SQL, predicate.Args)
	if err != nil {
		return nil, err
	}
	out.Series = append(out.Series, SizeHistoryPoint{
		EvaluatedAt: time.Now().UTC(),
		Count:       n,
	})
	return out, nil
}

// parseWindowDays accepts "90", "90d", "12w" — falls back to 90
// when input is empty or malformed. Clamps at 365 to bound the
// query cost.
func parseWindowDays(s string) int {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 90
	}
	mult := 1
	if strings.HasSuffix(s, "d") {
		s = strings.TrimSuffix(s, "d")
	} else if strings.HasSuffix(s, "w") {
		mult = 7
		s = strings.TrimSuffix(s, "w")
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 90
	}
	n *= mult
	if n > 365 {
		return 365
	}
	return n
}
