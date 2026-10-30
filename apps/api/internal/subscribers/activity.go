// Per-subscriber activity log: paginated read of subscriber_events
// scoped to a single subscriber. Cursor is `before=` (RFC3339); the
// last `at` from a page becomes the next page's `before`.

package subscribers

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ActivityRow is one event in the per-subscriber log.
type ActivityRow struct {
	ID         int64     `json:"id"`
	EventType  string    `json:"event_type"`
	CampaignID string    `json:"campaign_id,omitempty"`
	LinkURL    string    `json:"link_url,omitempty"`
	UserAgent  string    `json:"user_agent,omitempty"`
	At         time.Time `json:"at"`
}

// Activity reads up to `limit` events for the given subscriber, newest
// first, with optional `before` filter for cursor pagination.
func (r *Repo) Activity(ctx context.Context, tenantID, subscriberID string, limit int, before *time.Time) ([]ActivityRow, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	if err := tx.QueryRow(ctx, `
SELECT email::text FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriberID).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ErrNotFound, not a fresh error with the same words. The package
			// sentinel is literally errors.New("subscriber not found"), so a
			// freshly constructed twin reads identically in logs and in the
			// debugger while errors.Is against it returns false -- which is why
			// the handler could only treat an absent subscriber as an internal
			// failure and answer 500 where 404 is the truth.
			return nil, ErrNotFound
		}
		return nil, err
	}
	q := `
SELECT id, event_type, COALESCE(campaign_id::text, ''), COALESCE(link_url, ''),
       COALESCE(user_agent, ''), at
FROM subscriber_events
WHERE tenant_id = $1::uuid AND subscriber_email = $2`
	args := []any{tenantID, email}
	if before != nil {
		q += " AND at < $3"
		args = append(args, *before)
	}
	q += " ORDER BY at DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ActivityRow{}
	for rows.Next() {
		var a ActivityRow
		if err := rows.Scan(&a.ID, &a.EventType, &a.CampaignID, &a.LinkURL, &a.UserAgent, &a.At); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Activity GET /api/v1/subscribers/{id}/activity?limit=&before=
func (d *Deps) Activity(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	var before *time.Time
	if q := r.URL.Query().Get("before"); q != "" {
		if ts, err := time.Parse(time.RFC3339, q); err == nil {
			before = &ts
		}
	}
	rows, err := d.Repo.Activity(r.Context(), t.ID, id, limit, before)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "limit": limit})
}
