// SPDX-License-Identifier: AGPL-3.0-only
//
// recommendations.go — cross-tenant editorial Recommendations Network
// (gap feature `archive-recommendations-network`, P2, XL).
//
// Substack's Recommendations Network drove 32M+ in-app subscriptions
// in Q4 2025; beehiiv's Top-4 panel is a top acquisition channel for
// major publishers; Ghost ships Webmention-based recommendations.
//
// Three surfaces:
//
//  1. Public list — GET /api/public/archive/{tenant_slug}/recommendations
//     Returns the operator's active recommendations in `position` order,
//     limited to RecommendationsMaxPublic. Public renders this on the
//     archive index footer AND inline after the subscribe-wall CTA on
//     each issue page. Surface kept tiny on purpose: 5–6 rows is
//     the carousel sweet-spot Substack/beehiiv/Ghost converge on.
//
//  2. Click redirect — GET /api/public/archive/{tenant_slug}/recommendations/{id}/click
//     The public surface links every recommendation card through this
//     handler; we INSERT one row into recommendation_clicks (anon, salted-
//     day visitor id) and issue a 302 to the canonical target URL. Same
//     privacy model as archive_views — no IP, no UA, no referrer path.
//
//  3. Admin CRUD — list / upsert / delete (+ click rollup for the
//     desktop slideover analytics tile).
//
// Deferred (called out for the audit):
//
//   - Webmention parser: the receive endpoint + inbox table exist but
//     the source-page HTML parse + h-card author extraction lives in a
//     separate worker we haven't built. Rows queue with status='pending'
//     so no payloads are dropped today.
//
//   - Cross-tenant auto-discovery: `to_tenant_id` column reserves the
//     in-network resolver column but the job that populates it (host →
//     tenant_id via `tenant_public_settings.archive_domain` lookups) is
//     deferred. Operators today set up recommendations as plain outbound
//     URLs; the future job upgrades them to in-app one-click subscribes
//     without operator intervention.
//
//   - Reciprocal-recommendations admin UI: the reverse index exists
//     (tenant_recommendations_to_tenant_idx) so we can show "Foo and 12
//     others recommend you" in a future slideover; out of scope here.
//
// Compare-to: Substack `/publish/recommendations`, beehiiv "Boosts",
// Ghost `/dashboard/recommendations`.

package archive

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// RecommendationsMaxPublic caps the public-list response. Larger lists
// hurt page weight without driving uplift — beehiiv's Top-4 panel,
// Substack's "Recommendations from this writer" both cap at 6.
const RecommendationsMaxPublic = 6

// RecommendationsAdminCap caps the per-tenant total. Operators with
// more than this should split into per-segment recommendations (out of
// scope here — single panel for the launch).
const RecommendationsAdminCap = 50

// urlMaxLen is the upper bound on any URL column (to_url, source_url,
// target_url, author_url). Matches the cap on archive_hero_image; any
// row that needs more is almost certainly a buggy admin client.
const urlMaxLen = 2048

// labelMaxLen caps to_label / source_title / author_name. Matches the
// `subject` cap on campaigns.
const labelMaxLen = 200

// descriptionMaxLen caps to_description. 280 chars matches the Substack
// publication-description limit; gives room for one elevator-pitch
// sentence without ballooning the card.
const descriptionMaxLen = 280

// TenantRecommendation is the wire shape for the public + admin
// recommendations endpoints. The admin endpoints additionally fill
// `ClickCount30d` so the slideover can render a per-row "drove N
// clicks last 30d" tile.
type TenantRecommendation struct {
	ID            string    `json:"id"`
	ToURL         string    `json:"toURL"`
	ToLabel       string    `json:"toLabel"`
	ToDescription string    `json:"toDescription,omitempty"`
	ToImageURL    string    `json:"toImageURL,omitempty"`
	Position      int       `json:"position"`
	Active        bool      `json:"active"`
	ToTenantID    string    `json:"toTenantID,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	ClickCount30d int       `json:"clickCount30d,omitempty"`
}

// RecommendationsList is the wire shape both surfaces return. `Network`
// is set on the admin endpoint to "in-network" when at least one row
// has `to_tenant_id` populated — purely diagnostic so the slideover can
// show "X of Y are in-network".
type RecommendationsList struct {
	Items   []TenantRecommendation `json:"items"`
	Network string                 `json:"network,omitempty"`
}

// RecommendationInput is the upsert body. `ID` non-empty means update;
// empty means create. Position is optional — if omitted on a create the
// row appends at the end of the existing list.
type RecommendationInput struct {
	ID            string `json:"id,omitempty"`
	ToURL         string `json:"toURL"`
	ToLabel       string `json:"toLabel"`
	ToDescription string `json:"toDescription"`
	ToImageURL    string `json:"toImageURL"`
	Position      *int   `json:"position,omitempty"`
	Active        *bool  `json:"active,omitempty"`
}

var (
	errRecURLShape        = errors.New("recommendations: toURL must be an http(s) absolute URL")
	errRecURLTooLong      = errors.New("recommendations: toURL exceeds maximum length")
	errRecLabelTooLong    = errors.New("recommendations: toLabel exceeds maximum length")
	errRecDescTooLong     = errors.New("recommendations: toDescription exceeds maximum length")
	errRecImageURLTooLong = errors.New("recommendations: toImageURL exceeds maximum length")
	errRecCapExceeded     = errors.New("recommendations: per-tenant cap exceeded")
	errRecSelfLink        = errors.New("recommendations: cannot recommend self")
)

// validateRecommendationInput enforces the same shape rules the SQL
// CHECKs do, but earlier so callers get a structured 400 instead of a
// 23514 surface.
func validateRecommendationInput(tenantArchiveDomain string, in *RecommendationInput) error {
	in.ToURL = strings.TrimSpace(in.ToURL)
	in.ToLabel = strings.TrimSpace(in.ToLabel)
	in.ToDescription = strings.TrimSpace(in.ToDescription)
	in.ToImageURL = strings.TrimSpace(in.ToImageURL)
	if in.ToURL == "" {
		return errRecURLShape
	}
	if len(in.ToURL) > urlMaxLen {
		return errRecURLTooLong
	}
	u, err := url.Parse(in.ToURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errRecURLShape
	}
	if tenantArchiveDomain != "" && strings.EqualFold(u.Host, tenantArchiveDomain) {
		return errRecSelfLink
	}
	if len(in.ToLabel) > labelMaxLen {
		return errRecLabelTooLong
	}
	if len(in.ToDescription) > descriptionMaxLen {
		return errRecDescTooLong
	}
	if in.ToImageURL != "" {
		if len(in.ToImageURL) > urlMaxLen {
			return errRecImageURLTooLong
		}
		iu, err := url.Parse(in.ToImageURL)
		if err != nil || (iu.Scheme != "http" && iu.Scheme != "https") || iu.Host == "" {
			return errRecImageURLTooLong
		}
	}
	return nil
}

// ListRecommendationsPublic returns the active recommendations for the
// tenant, ordered by position then created_at. Caps the result at
// RecommendationsMaxPublic. Public surface — no PII fields exposed.
func (r *Repo) ListRecommendationsPublic(ctx context.Context, tenantID string, limit int) ([]TenantRecommendation, error) {
	if limit <= 0 || limit > RecommendationsMaxPublic {
		limit = RecommendationsMaxPublic
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, to_url, to_label, to_description, to_image_url,
       position, active, COALESCE(to_tenant_id::text, ''), created_at, updated_at
  FROM tenant_recommendations
 WHERE tenant_id = $1::uuid AND active = true
 ORDER BY position ASC, created_at ASC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TenantRecommendation, 0, limit)
	for rows.Next() {
		var rec TenantRecommendation
		if err := rows.Scan(
			&rec.ID, &rec.ToURL, &rec.ToLabel, &rec.ToDescription, &rec.ToImageURL,
			&rec.Position, &rec.Active, &rec.ToTenantID, &rec.CreatedAt, &rec.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListRecommendationsAdmin returns every recommendation row (active +
// inactive) for the supplied tenant, with the per-row 30d click count
// folded in via a LEFT JOIN. Bots excluded from the count.
func (r *Repo) ListRecommendationsAdmin(ctx context.Context, tenantID string) (*RecommendationsList, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT r.id::text, r.to_url, r.to_label, r.to_description, r.to_image_url,
       r.position, r.active, COALESCE(r.to_tenant_id::text, ''),
       r.created_at, r.updated_at,
       COALESCE(c.n, 0) AS click_count_30d
  FROM tenant_recommendations r
  LEFT JOIN (
    SELECT recommendation_id, COUNT(*) AS n
      FROM recommendation_clicks
     WHERE tenant_id = $1::uuid
       AND NOT bot
       AND clicked_at > now() - INTERVAL '30 days'
     GROUP BY recommendation_id
  ) c ON c.recommendation_id = r.id
 WHERE r.tenant_id = $1::uuid
 ORDER BY r.position ASC, r.created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &RecommendationsList{Items: []TenantRecommendation{}}
	hasInNetwork := false
	for rows.Next() {
		var rec TenantRecommendation
		if err := rows.Scan(
			&rec.ID, &rec.ToURL, &rec.ToLabel, &rec.ToDescription, &rec.ToImageURL,
			&rec.Position, &rec.Active, &rec.ToTenantID,
			&rec.CreatedAt, &rec.UpdatedAt, &rec.ClickCount30d,
		); err != nil {
			return nil, err
		}
		if rec.ToTenantID != "" {
			hasInNetwork = true
		}
		out.Items = append(out.Items, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if hasInNetwork {
		out.Network = "in-network"
	} else {
		out.Network = "outbound-only"
	}
	return out, nil
}

// UpsertRecommendation creates or updates a single recommendation. The
// caller pre-validates shape via validateRecommendationInput; this
// method enforces the per-tenant cap.
//
// When in.Position is nil on a create the new row appends at the end.
// On an update a nil position leaves the existing column untouched.
func (r *Repo) UpsertRecommendation(ctx context.Context, tenantID string, in RecommendationInput) (TenantRecommendation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TenantRecommendation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	create := in.ID == ""
	if create {
		// Enforce the per-tenant cap on the create path.
		var n int
		if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM tenant_recommendations WHERE tenant_id = $1::uuid`,
			tenantID).Scan(&n); err != nil {
			return TenantRecommendation{}, err
		}
		if n >= RecommendationsAdminCap {
			return TenantRecommendation{}, errRecCapExceeded
		}

		// Position: explicit value wins; otherwise append.
		pos := 0
		if in.Position != nil {
			pos = *in.Position
		} else {
			// COALESCE(MAX, -1) + 1 gives 0 on an empty list, otherwise
			// (max+1). Same pattern as `archive_related_overrides`.
			if err := tx.QueryRow(ctx, `
SELECT COALESCE(MAX(position), -1) + 1
  FROM tenant_recommendations
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&pos); err != nil {
				return TenantRecommendation{}, err
			}
		}
		active := true
		if in.Active != nil {
			active = *in.Active
		}

		var rec TenantRecommendation
		err := tx.QueryRow(ctx, `
INSERT INTO tenant_recommendations
    (tenant_id, to_url, to_label, to_description, to_image_url, position, active)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, to_url) DO UPDATE
    SET to_label       = EXCLUDED.to_label,
        to_description = EXCLUDED.to_description,
        to_image_url   = EXCLUDED.to_image_url,
        position       = EXCLUDED.position,
        active         = EXCLUDED.active,
        updated_at     = now()
RETURNING id::text, to_url, to_label, to_description, to_image_url,
          position, active, COALESCE(to_tenant_id::text, ''),
          created_at, updated_at`,
			tenantID, in.ToURL, in.ToLabel, in.ToDescription, in.ToImageURL, pos, active,
		).Scan(
			&rec.ID, &rec.ToURL, &rec.ToLabel, &rec.ToDescription, &rec.ToImageURL,
			&rec.Position, &rec.Active, &rec.ToTenantID,
			&rec.CreatedAt, &rec.UpdatedAt,
		)
		if err != nil {
			return TenantRecommendation{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return TenantRecommendation{}, err
		}
		return rec, nil
	}

	// Update path. Position + active use the PATCH-style "leave alone
	// when nil" convention.
	positionPresent := in.Position != nil
	positionVal := 0
	if positionPresent {
		positionVal = *in.Position
	}
	activePresent := in.Active != nil
	activeVal := false
	if activePresent {
		activeVal = *in.Active
	}

	var rec TenantRecommendation
	err = tx.QueryRow(ctx, `
UPDATE tenant_recommendations
   SET to_url         = $3,
       to_label       = $4,
       to_description = $5,
       to_image_url   = $6,
       position       = CASE WHEN $7::boolean THEN $8::int ELSE position END,
       active         = CASE WHEN $9::boolean THEN $10::boolean ELSE active END,
       updated_at     = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, to_url, to_label, to_description, to_image_url,
          position, active, COALESCE(to_tenant_id::text, ''),
          created_at, updated_at`,
		tenantID, in.ID, in.ToURL, in.ToLabel, in.ToDescription, in.ToImageURL,
		positionPresent, positionVal, activePresent, activeVal,
	).Scan(
		&rec.ID, &rec.ToURL, &rec.ToLabel, &rec.ToDescription, &rec.ToImageURL,
		&rec.Position, &rec.Active, &rec.ToTenantID,
		&rec.CreatedAt, &rec.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return TenantRecommendation{}, ErrNotFound
	}
	if err != nil {
		return TenantRecommendation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TenantRecommendation{}, err
	}
	return rec, nil
}

// DeleteRecommendation removes a single row by id. Returns ErrNotFound
// when the row doesn't exist (so callers can map to 404 cleanly).
// Cascade-deletes the corresponding click history (FK ON DELETE CASCADE).
func (r *Repo) DeleteRecommendation(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM tenant_recommendations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RecordRecommendationClick inserts one event row. Called from the
// public click-redirect handler before issuing the 302. The handler is
// responsible for bot detection + visitor-id hashing; this is the
// storage-only path so it stays trivially testable.
func (r *Repo) RecordRecommendationClick(
	ctx context.Context,
	tenantID, recID, visitorID, source, campaignSlug, refererHost string,
	bot bool,
) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var clickID string
	if err := tx.QueryRow(ctx, `
INSERT INTO recommendation_clicks
    (tenant_id, recommendation_id, anon_visitor_id, source, campaign_slug, referrer_host, bot)
VALUES ($1::uuid, $2::uuid, NULLIF(decode($3, 'hex'), ''::bytea), $4, NULLIF($5, ''), $6, $7)
RETURNING id::text`,
		tenantID, recID, visitorID, source, campaignSlug, refererHost, bot,
	).Scan(&clickID); err != nil {
		return "", err
	}
	return clickID, tx.Commit(ctx)
}

// RecordConversionByClickID records a conversion attributed to a prior
// recommendation click. The click id (an unguessable uuid handed to the
// destination via the ?rcid= redirect param) is the credential, so the lookup
// runs worker-scoped to resolve the click's tenant + recommendation without a
// tenant session (the public conversion endpoint has none). Idempotent: a
// second hit for the same click is a no-op so a re-fired pixel never
// double-counts.
func (r *Repo) RecordConversionByClickID(ctx context.Context, clickID, kind, referrerHost string) error {
	if kind == "" {
		kind = "confirmed_double_opt_in"
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantID, recID string
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text, recommendation_id::text
FROM recommendation_clicks WHERE id = $1::uuid`, clickID).Scan(&tenantID, &recID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// Atomic idempotency: the partial UNIQUE index on click_id (migration 1628)
	// makes ON CONFLICT DO NOTHING race-safe, so two concurrent re-fired pixels
	// for the same click can never both insert. (The prior WHERE NOT EXISTS form
	// could double-count under READ COMMITTED.)
	if _, err := tx.Exec(ctx, `
INSERT INTO recommendation_conversions
    (tenant_id, recommendation_id, click_id, kind, referrer_host)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
ON CONFLICT (click_id) WHERE click_id IS NOT NULL DO NOTHING`,
		tenantID, recID, clickID, kind, referrerHost); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// recommendationByID looks up a single row for redirect resolution.
// Public, used by the click handler — pulls only the URL + active flag
// so a deactivated row 404s the redirect cleanly.
func (r *Repo) recommendationByID(ctx context.Context, tenantID, id string) (string, bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		toURL  string
		active bool
	)
	err = tx.QueryRow(ctx, `
SELECT to_url, active FROM tenant_recommendations
 WHERE tenant_id = $1::uuid AND id::text = $2
 LIMIT 1`, tenantID, id).Scan(&toURL, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, ErrNotFound
	}
	if err != nil {
		return "", false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return toURL, active, nil
}

// ---------------------------------------------------------------------
// HTTP handlers — public surface
// ---------------------------------------------------------------------

// PublicRecommendations GET /api/public/archive/{tenant_slug}/recommendations
// Returns the active recommendations list. Cached for 5 min on the wire
// (mirrors the related-issues endpoint cache).
func (d *Deps) PublicRecommendations(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such archive")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := d.Repo.ListRecommendationsPublic(r.Context(), tid, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Strip admin-only fields on the public path.
	for i := range items {
		items[i].ClickCount30d = 0
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(RecommendationsList{Items: items})
}

// PublicRecommendationClick GET /api/public/archive/{tenant_slug}/recommendations/{id}/click
// Records the click + 302s the visitor to the canonical target URL.
// Returns 404 for unknown / inactive rows (same UX as a stale archive
// slug).
func (d *Deps) PublicRecommendationClick(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	id := chi.URLParam(r, "id")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such archive")
		return
	}
	toURL, active, err := d.Repo.recommendationByID(r.Context(), tid, id)
	if err != nil || !active {
		httperror.Write(w, http.StatusNotFound, "not_found", "no such recommendation")
		return
	}

	// Best-effort click record. We do not block the redirect on a
	// storage error — the visitor's outbound nav should never hang on
	// our analytics. Mirrors the archive_views pixel's
	// "fire-and-forget on insert failure" posture.
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	if source == "" {
		source = "issue"
	}
	if len(source) > 32 {
		source = source[:32]
	}
	campaignSlug := strings.TrimSpace(r.URL.Query().Get("campaign"))
	if len(campaignSlug) > 200 {
		campaignSlug = campaignSlug[:200]
	}
	referer := TrimReferrer(r.Header.Get("Referer"))
	refererHost := ""
	if referer != "" {
		if u, err := url.Parse(referer); err == nil {
			refererHost = u.Host
		}
	}
	bot := IsBotUserAgent(r.UserAgent())
	vid := DailyVisitorID(r, d.TrustForwardedIPHeaders)
	clickID, _ := d.Repo.RecordRecommendationClick(r.Context(), tid, id, vid, source, campaignSlug, refererHost, bot)

	// Append ?rcid=<click_id> so the destination can close the conversion loop
	// by calling /api/public/recommendations/conversion. Best-effort: a parse
	// failure or a non-recorded click just omits the param.
	if clickID != "" && !bot {
		toURL = appendRCID(toURL, clickID)
	}

	// 302 — short cache to avoid breaking a re-click measurement.
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, toURL, http.StatusFound)
}

// appendRCID adds the recommendation-click-id query param to a target URL,
// preserving any existing query. Returns the input unchanged on a parse error.
func appendRCID(target, clickID string) string {
	u, err := url.Parse(target)
	if err != nil {
		return target
	}
	q := u.Query()
	q.Set("rcid", clickID)
	u.RawQuery = q.Encode()
	return u.String()
}

// PublicRecommendationConversion GET /api/public/recommendations/conversion?rcid=<click_id>
// Records a conversion attributed to a prior recommendation click. Public +
// unauthenticated — the rcid (an unguessable click uuid) is the credential.
// Always 204 (a transparent-pixel-friendly no-content) regardless of whether
// the rcid resolves, so it never leaks existence and never blocks the visitor.
func (d *Deps) PublicRecommendationConversion(w http.ResponseWriter, r *http.Request) {
	rcid := strings.TrimSpace(r.URL.Query().Get("rcid"))
	if rcid != "" {
		referer := TrimReferrer(r.Header.Get("Referer"))
		refererHost := ""
		if referer != "" {
			if u, err := url.Parse(referer); err == nil {
				refererHost = u.Host
			}
		}
		kind := strings.TrimSpace(r.URL.Query().Get("kind"))
		if err := d.Repo.RecordConversionByClickID(r.Context(), rcid, kind, refererHost); err != nil && d.Logger != nil {
			d.Logger.Warn("recommendation conversion record failed", "err", err.Error())
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// PublicWebmention POST /api/public/webmention — Webmention receiver
// (W3C Webmention spec). Accepts any well-formed (source, target) pair
// and queues it in `webmentions_inbox` for the (deferred) parser.
//
// Receives application/x-www-form-urlencoded per spec; we also accept
// application/json for ergonomics. Always 202 on a well-formed payload
// regardless of whether the target host resolves to a tenant; the spec
// requires we not leak existence of a target.
//
// DEFERRED: parser worker that reads source HTML, extracts h-card
// author info, and surfaces a promote-to-recommendation prompt in the
// admin slideover.
func (d *Deps) PublicWebmention(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httperror.Write(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	var source, target string
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/json") {
		var body struct {
			Source string `json:"source"`
			Target string `json:"target"`
		}
		if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &body); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		source, target = body.Source, body.Target
	} else {
		// Spec-default content type.
		if err := r.ParseForm(); err != nil {
			httperror.WriteValidation(w, "invalid_body", err.Error())
			return
		}
		source = r.PostFormValue("source")
		target = r.PostFormValue("target")
	}
	source = strings.TrimSpace(source)
	target = strings.TrimSpace(target)
	if source == "" || target == "" || len(source) > urlMaxLen || len(target) > urlMaxLen {
		httperror.WriteValidation(w, "invalid_payload",
			"source and target are required and must be < 2KB")
		return
	}
	su, err := url.Parse(source)
	if err != nil || (su.Scheme != "http" && su.Scheme != "https") || su.Host == "" {
		httperror.WriteValidation(w, "invalid_source", "source must be http(s) URL")
		return
	}
	tu, err := url.Parse(target)
	if err != nil || (tu.Scheme != "http" && tu.Scheme != "https") || tu.Host == "" {
		httperror.WriteValidation(w, "invalid_target", "target must be http(s) URL")
		return
	}

	// Map target host → tenant via tenant_public_settings.archive_domain.
	// Best-effort; null tenant_id rows are still queued (the parser
	// triages them).
	if err := d.Repo.queueWebmention(r.Context(), source, target, tu.Host); err != nil {
		// Idempotent inserts via UNIQUE (source_url, target_url); only
		// real errors bubble out.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// queueWebmention inserts (or no-ops on duplicate) into webmentions_inbox.
// Tenant resolution happens inline via a host match — no RLS context is
// set on this path because the row may legitimately land with tenant_id
// NULL (orphan queue).
func (r *Repo) queueWebmention(ctx context.Context, source, target, targetHost string) error {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, `
INSERT INTO webmentions_inbox (tenant_id, source_url, target_url, status)
VALUES (
    (SELECT tenant_id FROM tenant_public_settings
       WHERE archive_domain = $3::citext
       LIMIT 1),
    $1, $2, 'pending'
)
ON CONFLICT (source_url, target_url) DO UPDATE SET received_at = now()`,
		source, target, targetHost)
	return err
}

// ---------------------------------------------------------------------
// HTTP handlers — admin surface
// ---------------------------------------------------------------------

// AdminListRecommendations GET /api/v1/admin/archive/recommendations
func (d *Deps) AdminListRecommendations(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListRecommendationsAdmin(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminUpsertRecommendation POST /api/v1/admin/archive/recommendations
// Body shape: RecommendationInput.
func (d *Deps) AdminUpsertRecommendation(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in RecommendationInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	// Resolve the tenant's own archive_domain so the validator can refuse
	// self-recommendation. Best-effort: an unset domain just disables
	// the self-check (the SQL CHECK still guards against to_tenant_id
	// self-pointers from the deferred discovery job).
	archiveDomain := ""
	if settings, err := d.Repo.GetTenantSettings(r.Context(), t.ID); err == nil {
		archiveDomain = strings.TrimSpace(settings.ArchiveDomain)
	}
	if err := validateRecommendationInput(archiveDomain, &in); err != nil {
		httperror.WriteValidation(w, "invalid_recommendation", err.Error())
		return
	}

	out, err := d.Repo.UpsertRecommendation(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, errRecCapExceeded):
			httperror.Write(w, http.StatusConflict, "cap_exceeded",
				"per-tenant recommendation cap reached")
			return
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "no such recommendation")
			return
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminDeleteRecommendation DELETE /api/v1/admin/archive/recommendations/{id}
func (d *Deps) AdminDeleteRecommendation(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.DeleteRecommendation(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such recommendation")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// MountRecommendationsRoutes registers all recommendations endpoints
// (public + admin + webmention receiver) on the supplied router. Kept
// in a separate Mount* function so the caller decides admin scope
// gating placement.
//
// Public + webmention: `r` is the public router (no auth, public rate
// limiter applied at the group level by the caller).
//
// Admin: gated by apikeys.RequireScope(apikeys.ScopeAdmin) so API-key
// callers carry `admin` scope and dashboard sessions are owner/admin role.
func (d *Deps) MountRecommendationsPublicRoutes(r chi.Router) {
	r.Get("/api/public/archive/{tenant_slug}/recommendations", d.PublicRecommendations)
	r.Get("/api/public/archive/{tenant_slug}/recommendations/{id}/click", d.PublicRecommendationClick)
	r.Get("/api/public/recommendations/conversion", d.PublicRecommendationConversion)
	r.Post("/api/public/webmention", d.PublicWebmention)
}

// MountRecommendationsAdminRoutes registers the admin CRUD endpoints.
// Caller mounts under the already-authenticated route group.
func (d *Deps) MountRecommendationsAdminRoutes(r chi.Router) {
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/admin/archive/recommendations", d.AdminListRecommendations)
	admin.Post("/api/v1/admin/archive/recommendations", d.AdminUpsertRecommendation)
	admin.Delete("/api/v1/admin/archive/recommendations/{id}", d.AdminDeleteRecommendation)
}
