// SPDX-License-Identifier: AGPL-3.0-only
//
// report.go is the support SLA / operations report. Tickets carried due_at +
// resolved_at and conversations carried timestamps, but nothing aggregated them
// — there was no backlog / breach / resolution-time / first-response view.
package service_suite

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// SupportReport is the read endpoint: GET /api/v1/service-suite/report[?since_days=].
func (d *Deps) SupportReport(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "since_days")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	sinceDays := 30
	if raw := values.Get("since_days"); raw != "" {
		sinceDays, err = strconv.Atoi(raw)
		if err != nil || sinceDays < 1 || sinceDays > 365 {
			writeJSON(w, http.StatusBadRequest, errEnv("since_days_invalid", "since_days must be an integer from 1 through 365"))
			return
		}
	}
	out, err := d.Repo.SupportReport(r.Context(), tid, sinceDays)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SupportReport is the helpdesk operations summary over a trailing window.
type SupportReport struct {
	TenantID                           string              `json:"tenantId"`
	TenantLegacyID                     string              `json:"tenant_id"`
	SinceDays                          int                 `json:"since_days"`
	AsOf                               time.Time           `json:"as_of"`
	WindowStartsAt                     time.Time           `json:"window_starts_at"`
	Consistency                        string              `json:"consistency"`
	Partial                            bool                `json:"partial"`
	Tickets                            SupportTicketReport `json:"tickets"`
	WindowCreatedConversationsByStatus map[string]int      `json:"window_created_conversations_by_status"`
	FirstResponseMedianMinutes         *float64            `json:"first_response_median_minutes"`
	FirstResponseEvidence              string              `json:"first_response_evidence_status"`
}

type SupportTicketReport struct {
	WindowCreatedByStatus                map[string]int `json:"window_created_by_status"`
	WindowCreatedByPriority              map[string]int `json:"window_created_by_priority"`
	WindowCreatedOpen                    int            `json:"window_created_open"`
	WindowCreatedOverdueDueDate          int            `json:"window_created_overdue_due_date"`
	DueDateEvidenceStatus                string         `json:"due_date_evidence_status"`
	WindowCreatedResolved                int            `json:"window_created_resolved"`
	WindowCreatedAvgResolutionMinutes    float64        `json:"window_created_avg_resolution_minutes"`
	WindowCreatedMedianResolutionMinutes float64        `json:"window_created_median_resolution_minutes"`
	ResolutionEvidenceStatus             string         `json:"resolution_evidence_status"`
}

// SupportReport aggregates tickets + conversations over the trailing sinceDays
// window (clamped to [1, 365]). All reads are RLS-scoped under one tx.
func (r *Repo) SupportReport(ctx context.Context, tenantID string, sinceDays int) (*SupportReport, error) {
	if sinceDays <= 0 {
		sinceDays = 30
	}
	if sinceDays > 365 {
		sinceDays = 365
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &SupportReport{
		TenantID:       tenantID,
		TenantLegacyID: tenantID,
		SinceDays:      sinceDays,
		Consistency:    "mutable_window",
		Partial:        true,
		Tickets: SupportTicketReport{
			WindowCreatedByStatus:    map[string]int{},
			WindowCreatedByPriority:  map[string]int{},
			DueDateEvidenceStatus:    "operator_due_date_only",
			ResolutionEvidenceStatus: "stored_ticket_timestamps_only",
		},
		WindowCreatedConversationsByStatus: map[string]int{},
		FirstResponseEvidence:              "unavailable_delivery_unverified",
	}
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&out.AsOf); err != nil {
		return nil, err
	}
	out.AsOf = out.AsOf.UTC()
	out.WindowStartsAt = out.AsOf.AddDate(0, 0, -sinceDays)

	byStatus, err := groupCount(ctx, tx, `
SELECT status, count(*) FROM support_tickets
WHERE tenant_id = $1::uuid AND created_at >= $2::timestamptz
  AND created_at <= $3::timestamptz
GROUP BY status`, tenantID, out.WindowStartsAt, out.AsOf)
	if err != nil {
		return nil, err
	}
	out.Tickets.WindowCreatedByStatus = byStatus

	byPriority, err := groupCount(ctx, tx, `
SELECT priority, count(*) FROM support_tickets
WHERE tenant_id = $1::uuid AND created_at >= $2::timestamptz
  AND created_at <= $3::timestamptz
GROUP BY priority`, tenantID, out.WindowStartsAt, out.AsOf)
	if err != nil {
		return nil, err
	}
	out.Tickets.WindowCreatedByPriority = byPriority

	// Current states for tickets created inside the requested window. These are
	// deliberately not named "backlog" or an unqualified "resolved": neither
	// is a whole-history tenant total.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE status IN ('open','pending','waiting')),
  count(*) FILTER (WHERE due_at < $3::timestamptz AND resolved_at IS NULL),
  count(*) FILTER (WHERE resolved_at IS NOT NULL)
FROM support_tickets
WHERE tenant_id = $1::uuid AND created_at >= $2::timestamptz
  AND created_at <= $3::timestamptz`,
		tenantID, out.WindowStartsAt, out.AsOf).Scan(&out.Tickets.WindowCreatedOpen, &out.Tickets.WindowCreatedOverdueDueDate, &out.Tickets.WindowCreatedResolved); err != nil {
		return nil, err
	}

	// Resolution time over resolved tickets (avg + median minutes).
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(avg(m), 0), COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY m), 0)
FROM (
  SELECT EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0 AS m
  FROM support_tickets
  WHERE tenant_id = $1::uuid AND resolved_at IS NOT NULL
    AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
) s`, tenantID, out.WindowStartsAt, out.AsOf).Scan(&out.Tickets.WindowCreatedAvgResolutionMinutes, &out.Tickets.WindowCreatedMedianResolutionMinutes); err != nil {
		return nil, err
	}

	convByStatus, err := groupCount(ctx, tx, `
SELECT status, count(*) FROM support_conversations
WHERE tenant_id = $1::uuid AND created_at >= $2::timestamptz
  AND created_at <= $3::timestamptz
GROUP BY status`, tenantID, out.WindowStartsAt, out.AsOf)
	if err != nil {
		return nil, err
	}
	out.WindowCreatedConversationsByStatus = convByStatus

	// Internal notes are not customer responses, and historical outbound rows
	// have no certified delivery evidence. Keep the metric explicitly null
	// instead of turning either record type into an SLA claim.

	return out, tx.Commit(ctx)
}

// groupCount runs a "SELECT key, count(*) ... GROUP BY key" query and returns
// the key→count map.
func groupCount(ctx context.Context, tx pgx.Tx, sql, tenantID string, windowStartsAt, asOf time.Time) (map[string]int, error) {
	rows, err := tx.Query(ctx, sql, tenantID, windowStartsAt, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return nil, err
		}
		out[key] = n
	}
	return out, rows.Err()
}
