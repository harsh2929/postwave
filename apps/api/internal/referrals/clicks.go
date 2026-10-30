// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RecordClick persists a public redirect hit. It is deliberately
// best-effort: a stats write must never block a referral redirect.
func (r *Repo) RecordClick(ctx context.Context, tenantID, code string, req *http.Request) {
	canonicalCode, valid := canonicalizeReferralLookupCode(code)
	if r == nil || r.Pool == nil || tenantID == "" || !valid {
		return
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ip := ""
	ua := ""
	ref := ""
	if req != nil {
		ip = clientIP(req)
		ua = strings.TrimSpace(req.UserAgent())
		if len(ua) > 512 {
			ua = ua[:512]
		}
		ref = strings.TrimSpace(req.Referer())
		if len(ref) > 1024 {
			ref = ref[:1024]
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO referral_clicks (tenant_id, code, ip, user_agent, referrer)
	VALUES ($1::uuid, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''))`,
		tenantID, canonicalCode, ip, ua, ref); err != nil {
		return
	}
	if _, err := tx.Exec(ctx, `
UPDATE referral_codes
   SET clicks_count = clicks_count + 1,
       last_clicked_at = now()
 WHERE id = (
    SELECT id
      FROM referral_codes
     WHERE tenant_id = $1::uuid
       AND (code = $2 OR desired_code = lower($2))
     ORDER BY CASE WHEN code = $2 THEN 0 ELSE 1 END
     LIMIT 1
 )`, tenantID, canonicalCode); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func clientIP(r *http.Request) string {
	for _, h := range []string{"CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"} {
		v := strings.TrimSpace(r.Header.Get(h))
		if v == "" {
			continue
		}
		if i := strings.IndexByte(v, ','); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		if v != "" {
			return v
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		return strings.Trim(host[:i], "[]")
	}
	return host
}

func (r *Repo) ClicksTotal(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	err = tx.QueryRow(ctx, `
SELECT COALESCE(SUM(clicks_count), 0)::int
  FROM referral_codes
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}
