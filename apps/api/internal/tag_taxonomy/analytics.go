// SPDX-License-Identifier: AGPL-3.0-only

package tag_taxonomy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MembershipBucket is one day in the exact post-1774 membership curve.
type MembershipBucket struct {
	Date string `json:"date"`
	Net  int64  `json:"net"`
}

// MembershipCoverage prevents callers from mistaking pre-ledger history for
// zeros. Every count is exact from CoverageStartedAt; a requested window may
// start earlier, which RequestedWindowComplete exposes explicitly.
type MembershipCoverage struct {
	ContractVersion         string    `json:"contract_version"`
	CoverageStartedAt       time.Time `json:"coverage_started_at"`
	AsOf                    time.Time `json:"as_of"`
	Completeness            string    `json:"completeness"`
	Source                  string    `json:"source"`
	RequestedWindowComplete bool      `json:"requested_window_complete"`
}

// MembershipResponse is the body returned by Membership().
type MembershipResponse struct {
	TagID        string             `json:"tag_id"`
	Days         int                `json:"days"`
	CurrentCount int64              `json:"current_count"`
	Added        int64              `json:"added"`
	Removed      int64              `json:"removed"`
	Daily        []MembershipBucket `json:"daily"`
	Coverage     MembershipCoverage `json:"coverage"`
}

// Membership handles GET /api/v1/tag-taxonomy/{tag_id}/membership. Summary,
// current count, daily buckets, coverage, and as-of are read in one SQL
// statement so every field describes one PostgreSQL snapshot.
func (d *Deps) Membership(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tagID := strings.TrimSpace(chi.URLParam(r, "tag_id"))
	parsedTagID, err := uuid.Parse(tagID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_tag_id", "tag_id must be a UUID")
		return
	}
	tagID = parsedTagID.String()
	days := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		parsed := parseSmallInt(raw)
		if parsed <= 0 {
			writeErr(w, http.StatusBadRequest, "invalid_days", "days must be an integer from 1 to 365")
			return
		}
		if parsed > 365 {
			parsed = 365
		}
		days = parsed
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var tagExists bool
	var current, added, removed int64
	var contractVersion *string
	var coverageStartedAt *time.Time
	var asOf time.Time
	var dailyRaw []byte
	err = tx.QueryRow(r.Context(), `
WITH clock AS (
    SELECT statement_timestamp() AS as_of
), coverage AS (
    SELECT contract_version, coverage_started_at
      FROM tag_membership_coverage
     WHERE tenant_id = $1::uuid
), windowed AS (
    SELECT event.action, event.occurred_at
      FROM tag_membership_events AS event
      CROSS JOIN clock
      CROSS JOIN coverage
     WHERE event.tenant_id = $1::uuid
       AND event.tag_id = $2::uuid
       AND event.occurred_at >= GREATEST(
           coverage.coverage_started_at,
           clock.as_of - make_interval(days => $3::integer)
       )
       AND event.occurred_at <= clock.as_of
), summary AS (
    SELECT count(*) FILTER (WHERE action = 'tag_added')::bigint AS added,
           count(*) FILTER (WHERE action = 'tag_removed')::bigint AS removed
      FROM windowed
), daily AS (
    SELECT date_trunc('day', occurred_at)::date AS day,
           (count(*) FILTER (WHERE action = 'tag_added') -
            count(*) FILTER (WHERE action = 'tag_removed'))::bigint AS net
      FROM windowed
     GROUP BY 1
)
SELECT EXISTS (
           SELECT 1 FROM tags
            WHERE tenant_id = $1::uuid AND id = $2::uuid
       ) AS tag_exists,
       (SELECT count(*)::bigint FROM subscriber_tags
         WHERE tenant_id = $1::uuid AND tag_id = $2::uuid) AS current_count,
       (SELECT contract_version FROM coverage),
       (SELECT coverage_started_at FROM coverage),
       clock.as_of,
       summary.added,
       summary.removed,
       COALESCE((
           SELECT jsonb_agg(
               jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'net', net)
               ORDER BY day
           ) FROM daily
       ), '[]'::jsonb)
  FROM clock
 CROSS JOIN summary`, tenant.ID, tagID, days).Scan(
		&tagExists, &current, &contractVersion, &coverageStartedAt, &asOf,
		&added, &removed, &dailyRaw,
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !tagExists {
		writeErr(w, http.StatusNotFound, "not_found", "tag not found")
		return
	}
	if contractVersion == nil || coverageStartedAt == nil {
		writeErr(w, http.StatusServiceUnavailable, "membership_coverage_unavailable",
			"membership coverage has not been established for this tenant")
		return
	}
	daily := make([]MembershipBucket, 0)
	if err := json.Unmarshal(dailyRaw, &daily); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, MembershipResponse{
		TagID:        tagID,
		Days:         days,
		CurrentCount: current,
		Added:        added,
		Removed:      removed,
		Daily:        daily,
		Coverage: MembershipCoverage{
			ContractVersion:         *contractVersion,
			CoverageStartedAt:       *coverageStartedAt,
			AsOf:                    asOf,
			Completeness:            "complete_from_coverage_start",
			Source:                  "subscriber_tags_event_ledger",
			RequestedWindowComplete: !coverageStartedAt.After(asOf.AddDate(0, 0, -days)),
		},
	})
}
