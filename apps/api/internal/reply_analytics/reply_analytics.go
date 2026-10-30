// SPDX-License-Identifier: AGPL-3.0-only
//
// Package reply_analytics surfaces aggregate metrics over the
// existing campaign_replies table (migration 0087). The replies
// package itself handles INGEST (Postmark / Mailgun / IMAP);
// this package handles READS for the campaign-performance UI.
//
// What this answers:
//
//   * per-campaign reply count + reply rate (% of recipients)
//   * top reply-senders across the tenant (engagement signal)
//   * timeseries of reply volume per day (early warning when
//     campaigns trigger unusual reply spikes — typically support
//     issues or complaint floods)
//
// Surfaces:
//
//   GET /api/v1/replies/summary                      ?days=30
//   GET /api/v1/replies/by-campaign/{id}             single campaign
//   GET /api/v1/replies/top-senders                  ?days=90&limit=20
//   GET /api/v1/replies/timeseries                   ?days=30

package reply_analytics

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

// Reply addresses and message previews are private correspondence. Aggregate
// counts remain readable with reports access, but identifying content needs
// an owner/admin user session (and must honor View-as-Viewer).
func canReadReplyIdentity(r *http.Request, tenantID string) bool {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u.TenantID != tenantID {
		return false
	}
	switch u.EffectiveRoleOrDurable() {
	case "owner", "admin":
		return true
	default:
		return false
	}
}

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the read endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/replies/summary", d.Summary)
	r.With(read).Get("/api/v1/replies/by-campaign/{id}", d.ByCampaign)
	r.With(read).Get("/api/v1/replies/top-senders", d.TopSenders)
	r.With(read).Get("/api/v1/replies/timeseries", d.Timeseries)
}

// Summary GET /api/v1/replies/summary?days=30.
//
// Tenant-wide reply totals + top campaigns by reply count.
func (d *Deps) Summary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := parseDays(r, 30)
	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var total, matched, unmatched int64
	var human, excluded, unclassified int64
	// The totals are a PIPELINE-HEALTH number, not an engagement one, so they
	// deliberately keep counting every inbound row — an operator debugging a
	// matcher needs to see the auto-replies. The classification breakdown is
	// added alongside so the difference between "inbound" and "engagement" is
	// legible in one response instead of inferred from two.
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) AS total,
       count(*) FILTER (WHERE campaign_id IS NOT NULL) AS matched,
       count(*) FILTER (WHERE campaign_id IS NULL)     AS unmatched,
       count(*) FILTER (WHERE `+replies.HumanReplyCondition+`)  AS human,
       count(*) FILTER (WHERE classification IS NOT NULL
                          AND classification <> 'human_reply') AS excluded,
       count(*) FILTER (WHERE classification IS NULL)          AS unclassified
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND received_at >= $2`,
		t.ID, since).Scan(&total, &matched, &unmatched, &human, &excluded, &unclassified); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Per-campaign counts are an ENGAGEMENT number, so only human replies count.
	// The shared predicate keeps this in step with the other four readers.
	rows, err := tx.Query(r.Context(), `
SELECT campaign_id::text, count(*) AS replies
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND received_at >= $2
   AND campaign_id IS NOT NULL`+replies.HumanEngagementPredicate+`
 GROUP BY campaign_id
 ORDER BY replies DESC
 LIMIT 20`, t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type campaignRow struct {
		CampaignID string `json:"campaign_id"`
		Replies    int64  `json:"replies"`
	}
	top := []campaignRow{}
	for rows.Next() {
		var c campaignRow
		if err := rows.Scan(&c.CampaignID, &c.Replies); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		top = append(top, c)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"total":       total,
		"matched":     matched,
		"unmatched":   unmatched,
		// The classification breakdown travels with the totals so a reader can
		// see WHY the engagement number is lower than the inbound count. Without
		// it, the drop when classification landed reads as a fall in replies
		// rather than a correction to what was being counted.
		"human_replies":        human,
		"excluded_non_human":   excluded,
		"unclassified_replies": unclassified,
		"top_campaigns":        top,
	})
}

// ByCampaign GET /api/v1/replies/by-campaign/{id}.
//
// Reply count + reply rate (% of distinct recipients); the most recent 50
// identifying previews are included only for an owner/admin user session.
func (d *Deps) ByCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// recipients = distinct subscriber_email across any subscriber_event
	// for this campaign — same approximation we use elsewhere in the
	// analytics layer.
	var replies, uniqueRecipients, distinctReplyers int64
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) AS replies,
       count(DISTINCT recipient_email) AS distinct_replyers
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		t.ID, id).Scan(&replies, &distinctReplyers); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.QueryRow(r.Context(), `
SELECT count(DISTINCT subscriber_email)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		t.ID, id).Scan(&uniqueRecipients); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	replyRate := float64(0)
	if uniqueRecipients > 0 {
		replyRate = float64(distinctReplyers) / float64(uniqueRecipients)
	}

	type reply struct {
		Email      string    `json:"recipient_email"`
		Subject    string    `json:"subject,omitempty"`
		Snippet    string    `json:"body_snippet,omitempty"`
		Source     string    `json:"source"`
		ReceivedAt time.Time `json:"received_at"`
	}
	previews := []reply{}
	canViewPreviews := canReadReplyIdentity(r, t.ID)
	if canViewPreviews {
		prevRows, err := tx.Query(r.Context(), `
SELECT recipient_email::text, COALESCE(subject, ''),
       COALESCE(body_snippet, ''), source, received_at
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY received_at DESC
 LIMIT 50`, t.ID, id)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		for prevRows.Next() {
			var rep reply
			if err := prevRows.Scan(&rep.Email, &rep.Subject, &rep.Snippet,
				&rep.Source, &rep.ReceivedAt); err != nil {
				prevRows.Close()
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
			previews = append(previews, rep)
		}
		if err := prevRows.Err(); err != nil {
			prevRows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		prevRows.Close()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign_id":       id,
		"replies":           replies,
		"distinct_replyers": distinctReplyers,
		"unique_recipients": uniqueRecipients,
		"reply_rate":        replyRate,
		"recent":            previews,
		"recent_restricted": !canViewPreviews,
	})
}

// TopSenders GET /api/v1/replies/top-senders.
//
// Subscribers who reply the most. Sender identities are private correspondence,
// so this endpoint requires an owner/admin user session in addition to scope.
func (d *Deps) TopSenders(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if !canReadReplyIdentity(r, t.ID) {
		httperror.Write(w, http.StatusForbidden, "reply_admin_required", "a workspace owner or admin session is required")
		return
	}
	days := parseDays(r, 90)
	since := time.Now().UTC().AddDate(0, 0, -days)
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT recipient_email::text, count(*) AS replies, max(received_at) AS last_at
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND received_at >= $2
 GROUP BY recipient_email
 ORDER BY replies DESC
 LIMIT $3`, t.ID, since, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type sender struct {
		Email   string    `json:"recipient_email"`
		Replies int64     `json:"replies"`
		LastAt  time.Time `json:"last_at"`
	}
	out := []sender{}
	for rows.Next() {
		var s sender
		if err := rows.Scan(&s.Email, &s.Replies, &s.LastAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"senders":     out,
	})
}

// Timeseries GET /api/v1/replies/timeseries?days=30.
func (d *Deps) Timeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := parseDays(r, 30)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
WITH series AS (
  SELECT generate_series(
    (CURRENT_DATE - ($2::int - 1))::date,
    CURRENT_DATE::date,
    INTERVAL '1 day'
  )::date AS day
)
SELECT s.day::text,
       COALESCE(count(r.id), 0)::int8
  FROM series s
  LEFT JOIN campaign_replies r
    ON r.tenant_id = $1::uuid AND r.received_at::date = s.day
 GROUP BY s.day
 ORDER BY s.day`, t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type point struct {
		Date    string `json:"date"`
		Replies int64  `json:"replies"`
	}
	out := []point{}
	for rows.Next() {
		var p point
		if err := rows.Scan(&p.Date, &p.Replies); err == nil {
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"points":      out,
	})
}

func parseDays(r *http.Request, def int) int {
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 365 {
			return n
		}
	}
	return def
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var _ = errors.New
