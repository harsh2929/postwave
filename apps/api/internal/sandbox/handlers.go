// SPDX-License-Identifier: AGPL-3.0-only
package sandbox

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// uuidRE matches RFC4122-shaped UUIDs (case-insensitive). Validating
// before the SQL ::uuid cast avoids a 500 + leaked Postgres SQLSTATE
// when callers pass garbage path params.
var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Handlers exposes HTTP endpoints over the sandbox state. Today there is
// just the status endpoint — implements GET /api/v1/sandbox/campaigns/{id}/status
// (declared in packages/openapi/openapi.yaml). The SDK and MCP server
// both call this; without the handler the call returns 404.
type Handlers struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// CampaignStatus is the response shape promised by the OpenAPI spec.
type CampaignStatus struct {
	CampaignID         string                   `json:"campaign_id"`
	State              string                   `json:"state"` // scheduled | running | completed
	ScheduledRemaining int                      `json:"scheduled_remaining"`
	Events             []map[string]interface{} `json:"events"`
}

// Status implements GET /api/v1/sandbox/campaigns/{id}/status.
//
// State derivation:
//   - "completed": all rows for this campaign are delivered=true.
//   - "running":   some rows delivered, some still pending and at <= now.
//   - "scheduled": no rows delivered yet (or every pending row's at > now).
//
// `scheduled_remaining` is the count of rows where delivered=false AND
// at > now (rows that are not yet eligible for the flusher). The
// `events` array is the most recent 50 rows for diagnostic display, in
// reverse-chronological order.
func (h *Handlers) Status(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	campaignID := chi.URLParam(r, "id")
	if campaignID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return
	}
	// Validate UUID shape BEFORE the SQL ::uuid cast. Without this,
	// garbage like `/api/v1/sandbox/campaigns/x/status` returns 500
	// with leaked Postgres SQLSTATE 22P02 in the response body.
	if !uuidRE.MatchString(campaignID) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id",
			"campaign id must be a UUID"))
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	now := time.Now().UTC()

	// Aggregate counts in a single query so we can derive state without
	// a second round-trip. COUNT FILTER is the cleanest way to express
	// "delivered count + pending-future count + total" together. A
	// COUNT(*) query always returns exactly one row (zeros when nothing
	// matches), so we don't special-case ErrNoRows here — the empty
	// case naturally lands in deriveState(0,0,0) which returns "scheduled".
	var (
		total     int
		delivered int
		future    int
	)
	if err := tx.QueryRow(r.Context(), `
		SELECT
			COUNT(*) AS total,
			COUNT(*) FILTER (WHERE delivered = true) AS delivered,
			COUNT(*) FILTER (WHERE delivered = false AND at > $2) AS future
		FROM sandbox_events
		WHERE tenant_id = $1::uuid AND campaign_id = $3::uuid
	`, t.ID, now, campaignID).Scan(&total, &delivered, &future); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	state := deriveState(total, delivered, future)

	events, err := loadRecentEvents(r.Context(), tx, t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, CampaignStatus{
		CampaignID:         campaignID,
		State:              state,
		ScheduledRemaining: future,
		Events:             events,
	})
}

// deriveState maps (total, delivered, future) to the spec's enum.
//   - total == 0                     → scheduled (nothing has been queued yet)
//   - delivered == total             → completed (every event has been promoted)
//   - delivered == 0 && future == total → scheduled (everything is in the future)
//   - else                           → running
func deriveState(total, delivered, future int) string {
	if total == 0 {
		return "scheduled"
	}
	if delivered == total {
		return "completed"
	}
	if delivered == 0 && future == total {
		return "scheduled"
	}
	return "running"
}

func loadRecentEvents(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) ([]map[string]interface{}, error) {
	rows, err := tx.Query(ctx, `
		SELECT subscriber_email, event_type, at, delivered
		FROM sandbox_events
		WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
		ORDER BY at DESC
		LIMIT 50
	`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var (
			email     string
			eventType string
			at        time.Time
			delivered bool
		)
		if err := rows.Scan(&email, &eventType, &at, &delivered); err != nil {
			return nil, err
		}
		out = append(out, map[string]interface{}{
			"subscriber_email": email,
			"event_type":       eventType,
			"at":               at.Format(time.RFC3339),
			"delivered":        delivered,
		})
	}
	return out, rows.Err()
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
