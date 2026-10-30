// Package archive serves the public campaign archive plus authenticated
// publication controls, analytics projections, and sitemap generation.
package archive

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// ErrNotFound is returned for a missing tenant or issue.
var ErrNotFound = errors.New("archive: not found")

var (
	// ErrInvalidCursor is returned before any database work for malformed
	// public/admin pagination state.
	ErrInvalidCursor = errors.New("archive: invalid cursor")
	// ErrCampaignNotPublishable keeps drafts, queued sends, and empty content
	// from becoming public through the archive-specific endpoint.
	ErrCampaignNotPublishable = errors.New("archive: only a sent campaign with publishable HTML can be published")
	// ErrPublishConflict covers a campaign that changed between the
	// eligibility read and the guarded update.
	ErrPublishConflict = errors.New("archive: campaign changed while it was being published")
	// ErrIssueSlugRequired prevents the old false-success state where
	// archive_public was enabled while archive_slug stayed NULL.
	ErrIssueSlugRequired = errors.New("archive: a non-empty issue slug is required")
)

// IssueSummary is the list-page projection.
//
// `Pinned` ships on every list response so the public index can
// render a "Featured" tag without a second round-trip. `ViewCount`
// and `UniqueVisitors` are admin-only — the public list endpoint
// leaves them zero, and the `omitempty` JSON tag keeps them out of
// the unauthenticated response.
type IssueSummary struct {
	Slug           string    `json:"slug"`
	Subject        string    `json:"subject"`
	Excerpt        string    `json:"excerpt"`
	PublishedAt    time.Time `json:"publishedAt"`
	Pinned         bool      `json:"pinned"`
	CampaignID     string    `json:"campaignId,omitempty"`
	ViewCount      int       `json:"viewCount,omitempty"`
	UniqueVisitors int       `json:"uniqueVisitors,omitempty"`
}

// IssueDetail is the read-by-slug projection. Carries the SEO knobs
// (meta_description / og_image / hero_image / author) so the public
// page can hydrate `<meta>` tags in a single fetch.
type IssueDetail struct {
	Slug            string    `json:"slug"`
	Subject         string    `json:"subject"`
	HTMLBody        string    `json:"htmlBody"`
	PublishedAt     time.Time `json:"publishedAt"`
	Pinned          bool      `json:"pinned"`
	MetaDescription string    `json:"metaDescription,omitempty"`
	OGImage         string    `json:"ogImage,omitempty"`
	HeroImage       string    `json:"heroImage,omitempty"`
	AuthorName      string    `json:"authorName,omitempty"`
	CanonicalURL    string    `json:"canonicalUrl,omitempty"`
	Excerpt         string    `json:"excerpt,omitempty"`
	// CampaignID is populated only on the admin-authenticated path
	// (it's the join key for the per-issue analytics drilldown).
	// `omitempty` keeps it out of the public response.
	CampaignID string `json:"campaignId,omitempty"`
}

// ListPage is a cursor-paginated list response.
type ListPage struct {
	Items      []IssueSummary `json:"items"`
	NextCursor string         `json:"nextCursor,omitempty"`
}

// Repo is the postgres surface — read-only.
type Repo struct {
	Pool *db.Pool
}

// TenantBySlug resolves a public archive slug to its owning tenant id.
// Public lookup; no tenant context.
func (r *Repo) TenantBySlug(ctx context.Context, slug string) (string, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var tid string
	err = conn.QueryRow(ctx, `
SELECT tenant_id::text FROM tenant_public_settings
 WHERE tenant_archive_slug = $1`, slug).Scan(&tid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return tid, err
}

// ListIssues returns up to limit (max 100) public issues for the tenant,
// optionally before the supplied cursor (an RFC3339 timestamp). When q is
// non-empty it filters by subject OR archive_slug substring (ILIKE).
//
// Uses db.WithTenant so the RLS-enforced campaigns SELECT sees the
// tenant-scoped row set. (Earlier versions used Pool.Acquire directly
// which silently returned 0 rows once RLS was forced on `campaigns`.)
//
// Delegates to listIssues with includeViews=false (public path).
func (r *Repo) ListIssues(ctx context.Context, tenantID, cursor string, limit int, q string) (ListPage, error) {
	return r.listIssues(ctx, tenantID, cursor, limit, q, false)
}

// ListIssuesAdmin is the admin variant that also rolls up 30d view
// counts + unique visitors per issue. Intentionally separate so the
// public path never leaks per-row traffic.
func (r *Repo) ListIssuesAdmin(ctx context.Context, tenantID, cursor string, limit int, q string) (ListPage, error) {
	return r.listIssues(ctx, tenantID, cursor, limit, q, true)
}

// ListSitemapIssues returns the public projection in sitemap order without
// reusing the interactive list's 100-row page cap. One sitemap is limited to
// 50,000 URLs by the protocol; the tenant index itself consumes one URL, so
// at most 49,999 issue URLs are returned here.
func (r *Repo) ListSitemapIssues(ctx context.Context, tenantID string) ([]IssueSummary, error) {
	const maxIssueURLs = 49_999
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT COALESCE(archive_slug, ''),
       COALESCE(subject, ''),
       COALESCE(archive_excerpt, ''),
       COALESCE(finished_at, created_at),
       COALESCE(archive_pinned, false)
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND archive_public = true
   AND archive_slug IS NOT NULL
 ORDER BY COALESCE(finished_at, created_at) DESC, id DESC
 LIMIT $2`, tenantID, maxIssueURLs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	issues := make([]IssueSummary, 0)
	for rows.Next() {
		var issue IssueSummary
		if err := rows.Scan(
			&issue.Slug,
			&issue.Subject,
			&issue.Excerpt,
			&issue.PublishedAt,
			&issue.Pinned,
		); err != nil {
			return nil, err
		}
		issues = append(issues, issue)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return issues, nil
}

func (r *Repo) listIssues(ctx context.Context, tenantID, cursor string, limit int, q string, includeViews bool) (ListPage, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	parsedCursor, err := parseArchiveCursor(cursor)
	if err != nil {
		return ListPage{}, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ListPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, limit + 1}
	// Two SELECT shapes — the admin one adds a LEFT JOIN against a
	// pre-aggregated subquery so the row count stays at one per
	// campaign. The pre-aggregation is cheap: the partial index
	// (tenant_id, campaign_id, anon_visitor_id) covers both counts.
	viewSelect := ""
	viewJoin := ""
	if includeViews {
		viewSelect = `, COALESCE(v.n, 0), COALESCE(v.u, 0)`
		viewJoin = `
  LEFT JOIN (
    SELECT campaign_id,
           COUNT(*) FILTER (WHERE NOT bot) AS n,
           COUNT(DISTINCT anon_visitor_id) FILTER (WHERE NOT bot AND anon_visitor_id IS NOT NULL) AS u
      FROM archive_views
     WHERE tenant_id = $1::uuid
       AND viewed_at > now() - INTERVAL '30 days'
     GROUP BY campaign_id
  ) v ON v.campaign_id = campaigns.id`
	}
	// Use `tenant_id = $1::uuid` on the outer WHERE so the parameter
	// has a single inferred type (uuid) across both the WHERE and the
	// LEFT JOIN subquery — mixed `::text`/`::uuid` casts confuse
	// Postgres's prepared-statement type inference (`operator does not
	// exist: text = uuid`).
	sqlQ := `
SELECT COALESCE(archive_slug, ''),
       COALESCE(subject, ''),
       COALESCE(archive_excerpt, ''),
       COALESCE(finished_at, created_at),
       COALESCE(archive_pinned, false),
       campaigns.id::text` + viewSelect + `
  FROM campaigns` + viewJoin + `
 WHERE tenant_id = $1::uuid
   AND archive_public = true
   AND archive_slug IS NOT NULL`
	sqlQ, args = appendArchiveCursorPredicate(sqlQ, args, parsedCursor)
	if q != "" {
		args = append(args, q)
		sqlQ += fmt.Sprintf(` AND (subject ILIKE '%%' || $%d || '%%' OR archive_slug ILIKE '%%' || $%d || '%%')`, len(args), len(args))
	}
	// Every ordered field is also present in the v2 cursor predicate.
	// The UUID is the immutable final tiebreaker for rows whose pinned
	// state and publication timestamp are exactly equal.
	sqlQ += ` ORDER BY COALESCE(archive_pinned, false) DESC, COALESCE(finished_at, created_at) DESC, campaigns.id DESC LIMIT $2`
	rows, err := tx.Query(ctx, sqlQ, args...)
	if err != nil {
		return ListPage{}, err
	}
	page := ListPage{Items: []IssueSummary{}}
	cursorCampaignIDs := make([]string, 0, limit+1)
	for rows.Next() {
		var s IssueSummary
		var (
			campaignID string
			n, u       int
		)
		if includeViews {
			if err := rows.Scan(
				&s.Slug,
				&s.Subject,
				&s.Excerpt,
				&s.PublishedAt,
				&s.Pinned,
				&campaignID,
				&n,
				&u,
			); err != nil {
				rows.Close()
				return ListPage{}, err
			}
			s.CampaignID = campaignID
			s.ViewCount = n
			s.UniqueVisitors = u
		} else {
			if err := rows.Scan(
				&s.Slug,
				&s.Subject,
				&s.Excerpt,
				&s.PublishedAt,
				&s.Pinned,
				&campaignID,
			); err != nil {
				rows.Close()
				return ListPage{}, err
			}
		}
		page.Items = append(page.Items, s)
		cursorCampaignIDs = append(cursorCampaignIDs, campaignID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ListPage{}, err
	}
	if len(page.Items) > limit {
		last := page.Items[limit-1]
		campaignID, parseErr := uuid.Parse(cursorCampaignIDs[limit-1])
		if parseErr != nil {
			return ListPage{}, fmt.Errorf("archive: encode cursor campaign id: %w", parseErr)
		}
		page.NextCursor = encodeArchiveCursor(last.Pinned, last.PublishedAt, campaignID)
		page.Items = page.Items[:limit]
	}
	if err := tx.Commit(ctx); err != nil {
		return ListPage{}, err
	}
	return page, nil
}

type archiveCursorKind uint8

const (
	archiveCursorNone archiveCursorKind = iota
	archiveCursorLegacyTimestamp
	archiveCursorLegacyCompound
	archiveCursorStable
)

type archiveCursor struct {
	kind        archiveCursorKind
	pinned      bool
	publishedAt time.Time
	campaignID  uuid.UUID
}

// parseArchiveCursor accepts the two historical cursor formats for clients
// that may have persisted one:
//   - a bare RFC3339 timestamp (oldest, lossy);
//   - base64url("p|<RFC3339Nano>") (pinned + timestamp, still lossy on ties).
//
// New responses use the stable, versioned v2 format decoded below.
func parseArchiveCursor(raw string) (archiveCursor, error) {
	if raw == "" {
		return archiveCursor{kind: archiveCursorNone}, nil
	}
	if decoded, ok := decodeArchiveCursor(raw); ok {
		return decoded, nil
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return archiveCursor{}, ErrInvalidCursor
	}
	return archiveCursor{
		kind:        archiveCursorLegacyTimestamp,
		publishedAt: t,
	}, nil
}

// appendArchiveCursorPredicate mirrors the DESC ordering in listIssues.
// Stable v2 cursors compare all three fields, so rows sharing an exact pinned
// state and timestamp advance by UUID instead of disappearing between pages.
// Historical cursors retain their former semantics for compatibility; their
// missing tiebreaker cannot be reconstructed and therefore remains lossy.
func appendArchiveCursorPredicate(sqlQ string, args []any, cursor archiveCursor) (string, []any) {
	switch cursor.kind {
	case archiveCursorStable:
		args = append(args, cursor.pinned, cursor.publishedAt, cursor.campaignID.String())
		sqlQ += fmt.Sprintf(
			` AND (COALESCE(archive_pinned, false), COALESCE(finished_at, created_at), campaigns.id) < ($%d::boolean, $%d::timestamptz, $%d::uuid)`,
			len(args)-2,
			len(args)-1,
			len(args),
		)
	case archiveCursorLegacyCompound:
		args = append(args, cursor.pinned, cursor.publishedAt)
		sqlQ += fmt.Sprintf(
			` AND (COALESCE(archive_pinned, false), COALESCE(finished_at, created_at)) < ($%d::boolean, $%d::timestamptz)`,
			len(args)-1,
			len(args),
		)
	case archiveCursorLegacyTimestamp:
		args = append(args, cursor.publishedAt)
		sqlQ += fmt.Sprintf(
			` AND COALESCE(finished_at, created_at) < $%d::timestamptz`,
			len(args),
		)
	}
	return sqlQ, args
}

// encodeArchiveCursor packs the complete ordering tuple into an opaque,
// URL-safe token. The explicit v2 marker distinguishes it from the older
// two-field compound cursor:
//
//	base64url("v2|p|<RFC3339Nano>|<campaign UUID>")
func encodeArchiveCursor(pinned bool, t time.Time, campaignID uuid.UUID) string {
	flag := "u"
	if pinned {
		flag = "p"
	}
	raw := "v2|" + flag + "|" + t.UTC().Format(time.RFC3339Nano) + "|" + campaignID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeArchiveCursor accepts stable v2 tokens and the prior encoded
// two-field token. ok=false lets parseArchiveCursor try the oldest bare
// timestamp form before rejecting the input as ErrInvalidCursor.
func decodeArchiveCursor(s string) (archiveCursor, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return archiveCursor{}, false
	}
	parts := strings.Split(string(b), "|")
	switch {
	case len(parts) == 4 && parts[0] == "v2":
		pinned, ok := decodeArchivePinnedFlag(parts[1])
		if !ok {
			return archiveCursor{}, false
		}
		t, err := time.Parse(time.RFC3339Nano, parts[2])
		if err != nil {
			return archiveCursor{}, false
		}
		campaignID, err := uuid.Parse(parts[3])
		if err != nil || campaignID == uuid.Nil {
			return archiveCursor{}, false
		}
		return archiveCursor{
			kind:        archiveCursorStable,
			pinned:      pinned,
			publishedAt: t,
			campaignID:  campaignID,
		}, true
	case len(parts) == 2:
		pinned, ok := decodeArchivePinnedFlag(parts[0])
		if !ok {
			return archiveCursor{}, false
		}
		t, err := time.Parse(time.RFC3339Nano, parts[1])
		if err != nil {
			return archiveCursor{}, false
		}
		return archiveCursor{
			kind:        archiveCursorLegacyCompound,
			pinned:      pinned,
			publishedAt: t,
		}, true
	default:
		return archiveCursor{}, false
	}
}

func decodeArchivePinnedFlag(flag string) (bool, bool) {
	switch flag {
	case "p":
		return true, true
	case "u":
		return false, true
	default:
		return false, false
	}
}

// GetIssue fetches one issue by tenant + archive slug. Includes the
// SEO + pinned columns so a single fetch hydrates the public detail
// page's `<head>` plus its hero block.
//
// Uses db.WithTenant so the SELECT runs inside a transaction with
// `app.tenant_id` pinned — campaigns has a PERMISSIVE tenant_isolation
// policy that returns zero rows when the GUC is unset, so an
// auto-commit conn.Acquire would silently 404 every public detail
// request (same bug ListIssues fixed earlier).
//
// CampaignID is populated; the public handler nulls it out before
// writing the response (admin callers keep it).
func (r *Repo) GetIssue(ctx context.Context, tenantID, slug string) (*IssueDetail, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var d IssueDetail
	var (
		body       *string
		excerpt    *string
		metaDesc   *string
		ogImage    *string
		heroImage  *string
		authorName *string
		canonical  *string
	)
	err = tx.QueryRow(ctx, `
SELECT id::text,
       COALESCE(archive_slug, ''), COALESCE(subject, ''),
       COALESCE(body, '')::text,
       COALESCE(finished_at, created_at),
       COALESCE(archive_pinned, false),
       archive_excerpt,
       archive_meta_description,
       archive_og_image,
       archive_hero_image,
       archive_author_name,
       archive_canonical_url
  FROM campaigns
 WHERE tenant_id::text = $1 AND archive_slug = $2 AND archive_public = true
 LIMIT 1`, tenantID, slug).Scan(
		&d.CampaignID, &d.Slug, &d.Subject, &body, &d.PublishedAt, &d.Pinned,
		&excerpt, &metaDesc, &ogImage, &heroImage, &authorName, &canonical,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if body != nil {
		d.HTMLBody = *body
	}
	if excerpt != nil {
		d.Excerpt = *excerpt
	}
	if metaDesc != nil {
		d.MetaDescription = *metaDesc
	}
	if ogImage != nil {
		d.OGImage = *ogImage
	}
	if heroImage != nil {
		d.HeroImage = *heroImage
	}
	if authorName != nil {
		d.AuthorName = *authorName
	}
	if canonical != nil {
		d.CanonicalURL = *canonical
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}

// PublishInput is the wire shape accepted by PublishCampaign + the
// AdminPublish handler. All fields except Slug+Excerpt are optional
// SEO knobs surfaced on the public issue page. Nil pointers leave
// the existing column untouched; explicit empty strings clear it.
type PublishInput struct {
	Slug            string  `json:"slug"`
	Excerpt         string  `json:"excerpt"`
	MetaDescription *string `json:"metaDescription,omitempty"`
	OGImage         *string `json:"ogImage,omitempty"`
	HeroImage       *string `json:"heroImage,omitempty"`
	AuthorName      *string `json:"authorName,omitempty"`
	CanonicalURL    *string `json:"canonicalUrl,omitempty"`
}

// PublishCampaign flips archive_public=true and stamps the supplied
// slug + excerpt + (optional) SEO knobs. Tenant-scoped. Nil SEO
// pointers preserve the existing column value so a partial PATCH-style
// update from the slideover doesn't accidentally wipe an OG image
// set in a previous save.
func (r *Repo) PublishCampaign(ctx context.Context, tenantID, campaignID string, in PublishInput) error {
	in.Slug = strings.TrimSpace(in.Slug)
	in.Excerpt = strings.TrimSpace(in.Excerpt)
	trimPublishInputPointers(&in)
	if in.Slug == "" {
		return ErrIssueSlugRequired
	}
	if err := ValidateArchiveSlug(in.Slug); err != nil {
		return err
	}
	if err := validatePublishInput(in); err != nil {
		return err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status   string
		bodyHTML string
	)
	err = tx.QueryRow(ctx, `
SELECT status, COALESCE(body_html, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
 FOR UPDATE`, tenantID, campaignID).Scan(&status, &bodyHTML)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status != "sent" || strings.TrimSpace(bodyHTML) == "" {
		return ErrCampaignNotPublishable
	}

	// G21: when the operator didn't set an OG image explicitly, derive
	// one from the first valid <img> in the campaign body so a shared
	// archive link still gets a social preview. Only fills when the
	// stored og_image is currently empty (the SQL CASE below enforces
	// that), so it never clobbers a previously-set value.
	derivedOG := ""
	if in.OGImage == nil {
		derivedOG = firstImageURL(bodyHTML)
	}

	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET archive_public           = true,
       archive_slug             = $2,
       archive_excerpt          = $3,
       body                     = body_html,
       archive_meta_description = CASE WHEN $4::boolean THEN $5 ELSE archive_meta_description END,
       archive_og_image         = CASE
                                    WHEN $6::boolean THEN $7
                                    WHEN $12 <> '' AND COALESCE(archive_og_image, '') = '' THEN $12
                                    ELSE archive_og_image
                                  END,
       archive_hero_image       = CASE WHEN $8::boolean THEN $9 ELSE archive_hero_image       END,
       archive_author_name      = CASE WHEN $10::boolean THEN $11 ELSE archive_author_name    END,
       archive_canonical_url    = CASE WHEN $13::boolean THEN NULLIF($14, '') ELSE archive_canonical_url END
 WHERE tenant_id = $15::uuid
   AND id = $1::uuid
   AND status = 'sent'
   AND COALESCE(body_html, '') <> ''`,
		campaignID, in.Slug, in.Excerpt,
		in.MetaDescription != nil, strPtrOrEmpty(in.MetaDescription),
		in.OGImage != nil, strPtrOrEmpty(in.OGImage),
		in.HeroImage != nil, strPtrOrEmpty(in.HeroImage),
		in.AuthorName != nil, strPtrOrEmpty(in.AuthorName),
		derivedOG,
		in.CanonicalURL != nil, strPtrOrEmpty(in.CanonicalURL),
		tenantID,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrSlugTaken
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPublishConflict
	}
	return tx.Commit(ctx)
}

func trimPublishInputPointers(in *PublishInput) {
	for _, value := range []*string{
		in.MetaDescription,
		in.OGImage,
		in.HeroImage,
		in.AuthorName,
		in.CanonicalURL,
	} {
		if value != nil {
			*value = strings.TrimSpace(*value)
		}
	}
}

func strPtrOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// UnpublishCampaign flips archive_public=false. Tenant-scoped.
func (r *Repo) UnpublishCampaign(ctx context.Context, tenantID, campaignID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaigns SET archive_public = false WHERE id::text = $1`, campaignID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Deps wires the public + admin handlers.
type Deps struct {
	Repo                        *Repo
	PublicBaseURL               string // e.g. https://archive.moosewave.com
	MembersOnlyResolver         MembersOnlyResolver
	SubscribeWallUnlockResolver SubscribeWallTokenResolver
	Recorder                    *ViewRecorder
	// TrustForwardedIPHeaders controls whether DailyVisitorID (and any
	// other handler-side client-IP resolution in this package) honours
	// X-Forwarded-For / X-Real-IP. Bind at handler-init time from
	// cfg.TrustForwardedIPHeaders — when false, raw XFF is ignored so a
	// caller can't spoof the anon_visitor_id hash for fingerprint
	// manipulation. See views.go DailyVisitorID for the threat model.
	TrustForwardedIPHeaders bool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// New() returns; nil-safe at the httperror call site.
	Logger *slog.Logger
}

const archiveJSONMaxBodyBytes int64 = 256 << 10 // 256 KiB

// MountPublicRenderRoutes hooks the read-only archive pages. They are split
// out from the write route because the hosted web renderer fetches them
// server-side, so every visitor of every tenant's archive collapses onto the
// web tier's single egress IP at the API boundary — the same reason the forms
// render surface owns a separate budget from forms submission. Callers wrap
// this in an egress-shaped limiter; see archive-render-shares-10rpm-public-bucket.
func (d *Deps) MountPublicRenderRoutes(r chi.Router) {
	r.Get("/api/public/archive/{tenant_slug}", d.PublicList)
	r.Get("/api/public/archive/{tenant_slug}/sitemap.xml", d.PublicSitemap)
	r.Get("/api/public/archive/{tenant_slug}/{campaign_slug}", d.PublicGet)
}

// MountPublicWriteRoutes hooks the subscribe-wall unlock. It is credential
// bearing and mutating, so it keeps the human-shaped anti-abuse budget rather
// than the render budget.
func (d *Deps) MountPublicWriteRoutes(r chi.Router) {
	r.Post("/api/public/archive/{tenant_slug}/unlock", d.UnlockSubscribeWall)
}

// MountPublicRoutes hooks the read-only public archive endpoints plus the
// unlock POST on one router. Callers that need the render and write halves to
// carry different rate-limit budgets mount the two halves separately.
// The pixel route is intentionally registered LAST and uses a fully
// qualified suffix (`/pixel.gif`) so it doesn't collide with the
// catch-all `{campaign_slug}` lookup.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	d.MountPublicRenderRoutes(r)
	d.MountPublicWriteRoutes(r)
}

// MountPixelRoute hooks the high-volume archive tracking pixel. It is
// intentionally separate from MountPublicRoutes so callers can wrap it
// in a dedicated, higher rate limit than human-facing archive routes.
func (d *Deps) MountPixelRoute(r chi.Router) {
	r.Get("/api/public/archive/{tenant_slug}/{campaign_slug}/pixel.gif", observability.RecordSurfaceFunc("archive", "view_pixel", d.PublicViewPixel))
}

// MountAdminRoutes hooks publish / unpublish / list (admin) endpoints
// plus the stats + pin/unpin toggles that power the dashboard tiles.
func (d *Deps) MountAdminRoutes(r chi.Router) {
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadReports, apikeys.ScopeAdmin))

	admin.Post("/api/v1/campaigns/{id}/publish-archive", observability.RecordSurfaceFunc("archive", "admin_publish", d.AdminPublish))
	admin.Post("/api/v1/campaigns/{id}/unpublish-archive", observability.RecordSurfaceFunc("archive", "admin_unpublish", d.AdminUnpublish))
	admin.Post("/api/v1/campaigns/{id}/archive/pin", observability.RecordSurfaceFunc("archive", "admin_pin", d.AdminPin))
	admin.Post("/api/v1/campaigns/{id}/archive/unpin", observability.RecordSurfaceFunc("archive", "admin_unpin", d.AdminUnpin))
	read.Get("/api/v1/archive", d.AdminList)
	read.Get("/api/v1/archive/stats", d.AdminStats)
	read.Get("/api/v1/admin/archive/issues/{slug}/preview", d.AdminPreview)
	d.MountTenantSettingsRoutes(r)
}

// PublicList GET /api/public/archive/{tenant_slug}
func (d *Deps) PublicList(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	cursor := r.URL.Query().Get("cursor")
	q := listsearch.ReadQuery(r.URL.Query())
	page, err := d.Repo.ListIssues(r.Context(), tid, cursor, limit, q)
	if err != nil {
		if errors.Is(err, ErrInvalidCursor) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// PublicGet GET /api/public/archive/{tenant_slug}/{campaign_slug}
func (d *Deps) PublicGet(w http.ResponseWriter, r *http.Request) {
	tid, err := d.Repo.TenantBySlug(r.Context(), chi.URLParam(r, "tenant_slug"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}
	issue, err := d.Repo.GetIssue(r.Context(), tid, chi.URLParam(r, "campaign_slug"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such issue"))
		return
	}
	// Strip operator-side identifiers before serialising on the
	// public path. The struct carries CampaignID for the admin
	// drilldown; recipients don't need it and the page shouldn't
	// leak internal ids.
	issue.CampaignID = ""
	writeJSON(w, http.StatusOK, issue)
}

// AdminPreview GET /api/v1/admin/archive/issues/{slug}/preview
func (d *Deps) AdminPreview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	issue, err := d.Repo.GetIssue(r.Context(), t.ID, chi.URLParam(r, "slug"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such issue"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, issue)
}

// PublicSitemap GET /api/public/archive/{tenant_slug}/sitemap.xml
func (d *Deps) PublicSitemap(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		writeSitemapError(w, http.StatusNotFound, "not_found", "no such archive")
		return
	}
	issues, err := d.Repo.ListSitemapIssues(r.Context(), tid)
	if err != nil {
		writeSitemapError(w, http.StatusInternalServerError, "list_failed", "server error")
		return
	}
	base := d.PublicBaseURL
	if base == "" {
		base = "https://archive.moosewave.com"
	}
	xmlBody := BuildSitemap(base+"/"+tslug, issues)
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	_, _ = w.Write([]byte(xmlBody))
}

// AdminPublish POST /api/v1/campaigns/{id}/publish-archive
func (d *Deps) AdminPublish(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in PublishInput
	if err := httpbody.DecodeJSONWith(w, r, archiveJSONMaxBodyBytes, &in, httpbody.Options{}); err != nil {
		writeJSON(w, httpbody.StatusCode(err), errEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign_id", "campaign id must be a UUID"))
		return
	}
	in.Slug = strings.TrimSpace(in.Slug)
	in.Excerpt = strings.TrimSpace(in.Excerpt)
	trimPublishInputPointers(&in)
	if in.Slug == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("slug_required", ErrIssueSlugRequired.Error()))
		return
	}
	if err := ValidateArchiveSlug(in.Slug); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("invalid_slug", err.Error()))
		return
	}
	if err := validatePublishInput(in); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(publishValidationErrorCode(err), err.Error()))
		return
	}
	if err := d.Repo.PublishCampaign(r.Context(), t.ID, id, in); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		case errors.Is(err, ErrCampaignNotPublishable):
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("campaign_not_publishable", err.Error()))
			return
		case errors.Is(err, ErrSlugTaken):
			writeJSON(w, http.StatusConflict, errEnv("slug_taken", err.Error()))
			return
		case errors.Is(err, ErrPublishConflict):
			writeJSON(w, http.StatusConflict, errEnv("publish_conflict", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func publishValidationErrorCode(err error) string {
	switch {
	case errors.Is(err, errPublishExcerptTooLong):
		return "invalid_excerpt"
	case errors.Is(err, errPublishMetaDescriptionTooLong):
		return "invalid_meta_description"
	case errors.Is(err, errPublishAuthorNameTooLong):
		return "invalid_author_name"
	case errors.Is(err, errPublishOGImageInvalid):
		return "invalid_og_image"
	case errors.Is(err, errPublishHeroImageInvalid):
		return "invalid_hero_image"
	case errors.Is(err, errPublishCanonicalURLTooLong),
		errors.Is(err, errPublishCanonicalURLInvalid):
		return "invalid_canonical_url"
	default:
		return "invalid_publish_input"
	}
}

// AdminUnpublish POST /api/v1/campaigns/{id}/unpublish-archive
func (d *Deps) AdminUnpublish(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign_id", "campaign id must be a UUID"))
		return
	}
	if err := d.Repo.UnpublishCampaign(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AdminList GET /api/v1/archive?q=
func (d *Deps) AdminList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	cursor := r.URL.Query().Get("cursor")
	q := listsearch.ReadQuery(r.URL.Query())
	// Admin variant includes per-row view aggregates so the dashboard
	// table can show "Views (30d)" alongside the title/slug/date.
	page, err := d.Repo.ListIssuesAdmin(r.Context(), t.ID, cursor, limit, q)
	if err != nil {
		if errors.Is(err, ErrInvalidCursor) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// ---------- sitemap ----------

type sitemapURL struct {
	XMLName xml.Name `xml:"url"`
	Loc     string   `xml:"loc"`
	LastMod string   `xml:"lastmod,omitempty"`
}

type sitemapDoc struct {
	XMLName xml.Name     `xml:"urlset"`
	XMLNS   string       `xml:"xmlns,attr"`
	URLs    []sitemapURL `xml:"url"`
}

type sitemapErrorDoc struct {
	XMLName xml.Name `xml:"error"`
	Code    string   `xml:"code"`
	Message string   `xml:"message,omitempty"`
}

// BuildSitemap renders a sitemap document for the supplied issue list.
// Exposed package-level so the test can pin the output without a DB.
func BuildSitemap(baseURL string, issues []IssueSummary) string {
	doc := sitemapDoc{XMLNS: "http://www.sitemaps.org/schemas/sitemap/0.9"}
	doc.URLs = append(doc.URLs, sitemapURL{Loc: baseURL})
	for _, it := range issues {
		doc.URLs = append(doc.URLs, sitemapURL{
			Loc:     baseURL + "/" + it.Slug,
			LastMod: it.PublishedAt.UTC().Format("2006-01-02"),
		})
	}
	body, _ := xml.MarshalIndent(doc, "", "  ")
	return xml.Header + string(body)
}

func writeSitemapError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(status)
	body, _ := xml.MarshalIndent(sitemapErrorDoc{Code: code, Message: message}, "", "  ")
	_, _ = w.Write([]byte(xml.Header))
	_, _ = w.Write(body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}
