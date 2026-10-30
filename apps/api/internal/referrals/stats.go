// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FunnelStats summarises conversions across three rolling windows.
// Window choice mirrors the Dashboard range chips so admins can
// align Referrals against the rest of their workspace overview.
//
// Click and fraud-filter totals are historical counters from the dormant
// referral runtime. They are useful for inspection but do not prove that the
// current signup path consumes referral attribution end to end.
type FunnelStats struct {
	Conversions7d      int `json:"conversions_7d"`
	Conversions30d     int `json:"conversions_30d"`
	Conversions90d     int `json:"conversions_90d"`
	ClicksTotal        int `json:"clicks_total"`
	FraudFilteredCount int `json:"fraud_filtered_count"`
}

// TopReferrer is one row in the leaderboard.
type TopReferrer struct {
	SubscriberID string    `json:"subscriber_id"`
	Count        int       `json:"count"`
	LastAt       time.Time `json:"last_at"`
}

// RecentConversion is a single line in the timeline.
type RecentConversion struct {
	ReferrerID string    `json:"referrer_id"`
	RefereeID  string    `json:"referee_id"`
	CreatedAt  time.Time `json:"created_at"`
}

// StatsResponse is the bundled payload returned by /referrals/stats.
type StatsResponse struct {
	Funnel       FunnelStats        `json:"funnel"`
	TopReferrers []TopReferrer      `json:"top_referrers"`
	Recent       []RecentConversion `json:"recent"`
}

// FunnelStats returns the three rolling-window counts in one query.
// Index used: referral_conversions (tenant_id, created_at DESC).
func (r *Repo) FunnelStats(ctx context.Context, tenantID string) (*FunnelStats, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &FunnelStats{}
	if err := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int,
  COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int,
  COUNT(*) FILTER (WHERE created_at >= now() - interval '90 days')::int
FROM referral_conversions
WHERE COALESCE(fraud_score, 0) < $1
  AND COALESCE(credit_status, 'credited') = 'credited'`,
		referralFraudThreshold).Scan(&out.Conversions7d, &out.Conversions30d, &out.Conversions90d); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
SELECT clicks_total, fraud_filtered_count
FROM (
    SELECT COALESCE(SUM(clicks_count), 0)::int AS clicks_total
      FROM referral_codes
     WHERE tenant_id = $1::uuid
) clicks
CROSS JOIN (
    SELECT COUNT(*) FILTER (WHERE COALESCE(fraud_score, 0) >= $2)::int AS fraud_filtered_count
      FROM referral_conversions
     WHERE tenant_id = $1::uuid
) fraud`,
		tenantID, referralFraudThreshold).Scan(&out.ClicksTotal, &out.FraudFilteredCount); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// TopReferrers lists the heaviest contributors over the last 90 days.
// Limit defaults to 10 (caps at 100). Returned newest-credit-first
// among ties so a recently-active power referrer ranks first.
func (r *Repo) TopReferrers(ctx context.Context, tenantID string, limit int) ([]TopReferrer, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT referrer_subscriber_id, count(*)::int AS n, max(created_at) AS last_at
FROM referral_conversions
WHERE created_at >= now() - interval '90 days'
  AND COALESCE(fraud_score, 0) < $1
  AND COALESCE(credit_status, 'credited') = 'credited'
GROUP BY referrer_subscriber_id
ORDER BY n DESC, last_at DESC
LIMIT `+strconv.Itoa(limit), referralFraudThreshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopReferrer{}
	for rows.Next() {
		var tr TopReferrer
		if err := rows.Scan(&tr.SubscriberID, &tr.Count, &tr.LastAt); err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	return out, rows.Err()
}

// RecentConversions returns the newest-first timeline.
func (r *Repo) RecentConversions(ctx context.Context, tenantID string, limit int) ([]RecentConversion, error) {
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT referrer_subscriber_id, referee_subscriber_id, created_at
FROM referral_conversions
WHERE COALESCE(fraud_score, 0) < $1
  AND COALESCE(credit_status, 'credited') = 'credited'
ORDER BY created_at DESC
LIMIT `+strconv.Itoa(limit), referralFraudThreshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecentConversion{}
	for rows.Next() {
		var rc RecentConversion
		if err := rows.Scan(&rc.ReferrerID, &rc.RefereeID, &rc.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rc)
	}
	return out, rows.Err()
}

// Stats GET /api/v1/referrals/stats — bundled response so the admin
// page fills in one round trip.
func (d *Deps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "repository unavailable")
		return
	}
	funnel, err := d.Repo.FunnelStats(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	top, err := d.Repo.TopReferrers(r.Context(), t.ID, 10)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	recent, err := d.Repo.RecentConversions(r.Context(), t.ID, 20)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, StatsResponse{
		Funnel:       *funnel,
		TopReferrers: top,
		Recent:       recent,
	})
}

// Credit POST /api/v1/referrals/credit
//
// Reads the pw_ref cookie + a {subscriber_id} body, finds the
// referrer who owns that code, and writes the conversion. Idempotent
// via the unique (tenant, referrer, referee) constraint — repeat
// calls are silently de-duplicated by the existing CreditConversion
// implementation.
//
// Returns {credited: bool} so the signup form can telemetry the
// outcome without branching on HTTP status.
func (d *Deps) Credit(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "repository unavailable")
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant.ID == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Body is small — JSON-only with a tight cap.
	var in struct {
		SubscriberID string `json:"subscriber_id"`
	}
	if err := httpbody.DecodeJSON(w, r, 4*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	if in.SubscriberID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_subscriber", "subscriber_id is required")
		return
	}
	if _, err := uuid.Parse(in.SubscriberID); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_subscriber", "subscriber_id must be a UUID")
		return
	}
	c, err := r.Cookie(CookieName)
	if err != nil || c == nil || c.Value == "" {
		writeJSON(w, http.StatusOK, map[string]any{"credited": false, "reason": "no_cookie"})
		return
	}
	code, cookieTenantID, referrerSubscriberID, legacy, err := parseReferralCookie(c.Value, d.CookieSecret, time.Now())
	if err != nil {
		expireReferralCookie(w)
		writeJSON(w, http.StatusOK, map[string]any{"credited": false, "reason": "bad_cookie"})
		return
	}
	if !legacy && cookieTenantID != tenant.ID {
		expireReferralCookie(w)
		writeJSON(w, http.StatusOK, map[string]any{"credited": false, "reason": "tenant_mismatch"})
		return
	}
	credited, err := d.Repo.CreditConversionForTenantCookieWithIP(
		r.Context(), tenant.ID, code, referrerSubscriberID, in.SubscriberID, clientIP(r),
	)
	if err != nil {
		// CreditConversion's contract: ErrNotFound when the code's
		// referrer doesn't exist; everything else is a real failure.
		if err == ErrNotFound {
			writeJSON(w, http.StatusOK, map[string]any{"credited": false, "reason": "unknown_code"})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credited": credited})
}

func expireReferralCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}
