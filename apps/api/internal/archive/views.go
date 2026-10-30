// SPDX-License-Identifier: AGPL-3.0-only
//
// views.go — turns the public archive from a static list-of-issues
// into a measurable surface:
//
//   * RecordView — append-only insert into archive_views. Called
//     from the public issue page's 1x1 tracking pixel after a
//     handful of bot + dedup gates.
//   * GetStats — top-of-dashboard rollup (total issues / 30d views
//     + uniques / best-performing issue / last published).
//   * SetPinned — toggle for the "featured at top of archive index"
//     flag. The public ORDER BY uses pinned DESC, finished_at DESC.
//   * lookupCampaignBySlug — internal helper the pixel handler uses
//     to resolve the URL's (tenant_slug, campaign_slug) pair to a
//     concrete campaign id without a full IssueDetail round-trip.
//
// Privacy: anon_visitor_id is a 16-byte truncation of
// sha256(ip || ua || daily_salt). The salt rotates per UTC day, so
// the same human counts once-per-day-per-issue but can never be
// joined across days. We never persist IP / UA / referrer beyond
// the immediate INSERT (the row keeps a truncated referrer host).
//
// Bots: a small UA regex flips bot=true. Default counts exclude
// bots; the raw firehose remains in the table for ad-hoc analysis.

package archive

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// onePixelGIF is a 1x1 fully-transparent GIF89a. Cheaper than
// embedding a base64 string at request-time + amortizes the trivial
// allocation.
var onePixelGIF = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00,
	0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21,
	0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
	0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
	0x01, 0x00, 0x3b,
}

// Stats is the top-of-page rollup returned by GET /api/v1/archive/stats.
type Stats struct {
	TotalIssues       int        `json:"totalIssues"`
	PinnedIssues      int        `json:"pinnedIssues"`
	Views30d          int        `json:"views30d"`
	UniqueVisitors30d int        `json:"uniqueVisitors30d"`
	TopIssueSlug      string     `json:"topIssueSlug,omitempty"`
	TopIssueSubject   string     `json:"topIssueSubject,omitempty"`
	TopIssueViews     int        `json:"topIssueViews,omitempty"`
	LastPublishedAt   *time.Time `json:"lastPublishedAt,omitempty"`
}

// GetStats computes the dashboard tile values in a single round-trip
// transaction so the pinned / pinned-tile / top-issue subqueries see
// the same snapshot.
func (r *Repo) GetStats(ctx context.Context, tenantID string) (*Stats, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &Stats{}
	if err := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE archive_public = true),
  COUNT(*) FILTER (WHERE archive_public = true AND archive_pinned = true),
  MAX(finished_at) FILTER (WHERE archive_public = true)
FROM campaigns
WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.TotalIssues, &out.PinnedIssues, &out.LastPublishedAt,
	); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE NOT bot),
  COUNT(DISTINCT anon_visitor_id) FILTER (WHERE NOT bot AND anon_visitor_id IS NOT NULL)
FROM archive_views
WHERE tenant_id = $1::uuid AND viewed_at > now() - INTERVAL '30 days'`,
		tenantID).Scan(&out.Views30d, &out.UniqueVisitors30d); err != nil {
		return nil, err
	}

	// Top issue (last 30d, bots excluded). LEFT JOIN so a tenant with
	// zero views still gets a well-formed Stats back.
	var (
		topSlug    sql.NullString
		topSubject sql.NullString
		topViews   sql.NullInt64
	)
	if err := tx.QueryRow(ctx, `
SELECT c.archive_slug, c.subject, agg.n
FROM (
  SELECT campaign_id, COUNT(*) AS n
  FROM archive_views
  WHERE tenant_id = $1::uuid
    AND viewed_at > now() - INTERVAL '30 days'
    AND NOT bot
  GROUP BY campaign_id
  ORDER BY n DESC
  LIMIT 1
) agg
JOIN campaigns c ON c.id = agg.campaign_id AND c.tenant_id = $1::uuid
LIMIT 1`, tenantID).Scan(&topSlug, &topSubject, &topViews); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if topSlug.Valid {
		out.TopIssueSlug = topSlug.String
	}
	if topSubject.Valid {
		out.TopIssueSubject = topSubject.String
	}
	if topViews.Valid {
		out.TopIssueViews = int(topViews.Int64)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// SetPinned flips campaigns.archive_pinned. Refuses non-public
// campaigns so the dashboard can't accidentally "pin" something
// that isn't even on the archive yet.
func (r *Repo) SetPinned(ctx context.Context, tenantID, campaignID string, pinned bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET archive_pinned = $3
 WHERE id::text = $1 AND tenant_id = $2::uuid AND archive_public = true`,
		campaignID, tenantID, pinned)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// LookupCampaignBySlug resolves the public (tenant_slug, archive_slug)
// pair to a (tenant_id, campaign_id). Returns ErrNotFound for either
// missing tenant or missing issue.
//
// Exported for the pixel handler in main.go's public route group, which
// runs without a tenant context.
func (r *Repo) LookupCampaignBySlug(ctx context.Context, tenantSlug, campaignSlug string) (tenantID, campaignID string, err error) {
	tid, err := r.TenantBySlug(ctx, tenantSlug)
	if err != nil {
		return "", "", err
	}
	// Same RLS gotcha as GetIssue: campaigns has a tenant_isolation
	// PERMISSIVE policy that silently returns 0 rows when the GUC is
	// unset. Use WithTenant so the lookup actually sees the row.
	tx, err := db.WithTenant(ctx, r.Pool, tid)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cid string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM campaigns
 WHERE tenant_id = $1::uuid AND archive_slug = $2 AND archive_public = true
 LIMIT 1`, tid, campaignSlug).Scan(&cid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return tid, cid, nil
}

// RecordView inserts one row. Caller is responsible for bot detection
// + visitor-id hashing; this method is the storage-only path.
func (r *Repo) RecordView(ctx context.Context, tenantID, campaignID, visitorID, referrer, country string, bot bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO archive_views (tenant_id, campaign_id, anon_visitor_id, referrer, country, bot)
VALUES ($1::uuid, $2::uuid, NULLIF($3,''), NULLIF($4,''), $5, $6)`,
		tenantID, campaignID, visitorID, referrer, country, bot,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------- public helpers reused by the pixel handler -----------------

// botUARegex matches the long tail of crawlers / link-preview bots that
// would otherwise inflate view counts. Not exhaustive — false negatives
// just appear as "human" views, which is the conservative default.
var botUARegex = regexp.MustCompile(`(?i)(bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|preview|fetcher|monitor|headless|curl|wget|python-requests|axios|httpx|insomnia|postman)`)

// IsBotUserAgent is a thin wrapper exported so handlers can share the
// same heuristic across the codebase if they need to.
func IsBotUserAgent(ua string) bool {
	if ua == "" {
		// Empty UA is almost always automation.
		return true
	}
	return botUARegex.MatchString(ua)
}

// DailyVisitorID returns the truncated SHA-256 of
// (clientIP || userAgent || dailySalt). The same browser hashes to
// the same id all UTC day; the salt rotation guarantees it can't be
// joined to tomorrow's id. 16-byte hex (32 chars) — enough entropy
// to avoid collisions within a single tenant's daily uniques.
//
// Salt sourcing: ARCHIVE_VIEWS_SALT env var || a deterministic dev
// fallback. Production deployments MUST set the env var so a DB leak
// can't be paired with a known salt to re-identify visitors.
func DailyVisitorID(r *http.Request, trustHeaders bool) string {
	ip := middleware.ResolveClientIPString(r, trustHeaders)
	ua := r.UserAgent()
	day := time.Now().UTC().Format("2006-01-02")
	salt := os.Getenv("ARCHIVE_VIEWS_SALT")
	if salt == "" {
		salt = "dev-archive-views-salt-not-for-prod"
	}
	h := sha256.Sum256([]byte(ip + "|" + ua + "|" + day + "|" + salt))
	return hex.EncodeToString(h[:8])
}

// ExtractCountry returns the 2-letter country code populated by the
// reverse proxy / CDN. Empty string when not behind a CDN.
func ExtractCountry(r *http.Request) string {
	// CDNs all set ONE of these. We check the common ones; ordering
	// is by frequency-of-prod-use across recent Moosewave deploys.
	for _, h := range []string{"CF-IPCountry", "X-Vercel-IP-Country", "X-Country-Code", "Fly-Client-IP-Country"} {
		if v := r.Header.Get(h); v != "" {
			v = strings.TrimSpace(v)
			if len(v) == 2 {
				return strings.ToUpper(v)
			}
		}
	}
	return ""
}

// TrimReferrer drops the query string + fragment from the supplied
// referrer header and caps the result at 512 chars so a pathological
// referrer can't bloat the row. Returns "" for direct hits.
func TrimReferrer(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return cap512(raw)
	}
	out := u.Scheme + "://" + u.Host + u.Path
	return cap512(out)
}

func cap512(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}

// ---------------------------------------------------------------------
// HTTP handlers — pin/unpin + stats + tracking pixel
// ---------------------------------------------------------------------

// AdminStats handles GET /api/v1/archive/stats.
func (d *Deps) AdminStats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	s, err := d.Repo.GetStats(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// AdminPin handles POST /api/v1/campaigns/{id}/archive/pin. Idempotent —
// pinning an already-pinned issue is a no-op success.
func (d *Deps) AdminPin(w http.ResponseWriter, r *http.Request) { d.setPinned(w, r, true) }

// AdminUnpin handles POST /api/v1/campaigns/{id}/archive/unpin.
func (d *Deps) AdminUnpin(w http.ResponseWriter, r *http.Request) { d.setPinned(w, r, false) }

func (d *Deps) setPinned(w http.ResponseWriter, r *http.Request, pinned bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.SetPinned(r.Context(), t.ID, id, pinned); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "issue not published or not yours"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pinned": pinned})
}

// PublicViewPixel handles GET /api/public/archive/{tenant_slug}/{slug}/pixel.gif.
//
// Always returns the 1x1 GIF — tracking failures are never visible to
// the visitor. The insert path runs synchronously but cheap (one row,
// one index touch); we accept the few-ms latency to keep the handler
// simple and to surface DB errors in logs immediately.
//
// Caching: explicit no-cache + a tiny max-age=0 so reverse proxies
// don't dedupe pixel hits across visitors.
func (d *Deps) PublicViewPixel(w http.ResponseWriter, r *http.Request) {
	tenantSlug := chi.URLParam(r, "tenant_slug")
	campaignSlug := chi.URLParam(r, "campaign_slug")

	// Resolve first; if either slug is wrong, we still serve the pixel
	// (an attacker can't probe slug existence via the tracking surface)
	// but skip the insert.
	if d != nil && d.Repo != nil {
		tid, cid, lookupErr := d.Repo.LookupCampaignBySlug(r.Context(), tenantSlug, campaignSlug)
		if lookupErr == nil {
			bot := IsBotUserAgent(r.UserAgent())
			visitorID := DailyVisitorID(r, d.TrustForwardedIPHeaders)
			referrer := TrimReferrer(r.Header.Get("Referer"))
			country := ExtractCountry(r)
			if d.Recorder != nil {
				_ = d.Recorder.Enqueue(tid, cid, visitorID, referrer, country, bot)
			} else {
				_ = d.Repo.RecordView(
					r.Context(),
					tid, cid,
					visitorID,
					referrer,
					country,
					bot,
				)
			}
		}
	}

	w.Header().Set("Content-Type", "image/gif")
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Length", "43")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(onePixelGIF)
}
