// SPDX-License-Identifier: AGPL-3.0-only
//
// Package landingpages exposes admin CRUD over the landing_pages table
// (defined in migration 0028).
//
// The public render path lives in apps/web (Next.js renders the page
// at /landing/[slug]); this package owns the editor + admin surface
// the web app calls into.
package landingpages

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Status is the lifecycle field on the row.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusPublished Status = "published"
	StatusArchived  Status = "archived"
)

// LandingPage is the persisted row.
type LandingPage struct {
	ID        string           `json:"id"`
	TenantID  string           `json:"tenant_id"`
	Slug      string           `json:"slug"`
	Name      string           `json:"name"`
	Status    Status           `json:"status"`
	Domain    string           `json:"domain,omitempty"`
	Template  string           `json:"template"`
	Blocks    []map[string]any `json:"blocks"`
	SEO       map[string]any   `json:"seo"`
	Tracking  map[string]any   `json:"tracking"`
	Metrics   map[string]any   `json:"metrics"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
	// LAND-038 scheduling. Nullable: a draft with PublishAt<=now auto-publishes;
	// a published page with UnpublishAt<=now auto-reverts to draft.
	PublishAt   *time.Time `json:"publish_at,omitempty"`
	UnpublishAt *time.Time `json:"unpublish_at,omitempty"`
}

// CreateInput is the body of POST /api/v1/landing-pages.
type CreateInput struct {
	Slug        string           `json:"slug"`
	Name        string           `json:"name"`
	Domain      string           `json:"domain,omitempty"`
	Template    string           `json:"template,omitempty"`
	Blocks      []map[string]any `json:"blocks,omitempty"`
	SEO         map[string]any   `json:"seo,omitempty"`
	Tracking    map[string]any   `json:"tracking,omitempty"`
	PublishAt   *time.Time       `json:"publish_at,omitempty"`
	UnpublishAt *time.Time       `json:"unpublish_at,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/landing-pages/{id}.
type UpdateInput struct {
	Name     *string           `json:"name,omitempty"`
	Slug     *string           `json:"slug,omitempty"`
	Status   *Status           `json:"status,omitempty"`
	Domain   *string           `json:"domain,omitempty"`
	Template *string           `json:"template,omitempty"`
	Blocks   *[]map[string]any `json:"blocks,omitempty"`
	SEO      *map[string]any   `json:"seo,omitempty"`
	Tracking *map[string]any   `json:"tracking,omitempty"`
	// LAND-038 scheduling — tri-state: absent = leave unchanged; JSON null =
	// clear the schedule; a timestamp = (re)schedule. A nil pointer alone can't
	// tell "clear" from "omit", so presence is tracked separately.
	PublishAt      *time.Time `json:"publish_at,omitempty"`
	UnpublishAt    *time.Time `json:"unpublish_at,omitempty"`
	HasPublishAt   bool       `json:"-"`
	HasUnpublishAt bool       `json:"-"`
}

// UnmarshalJSON tracks whether publish_at/unpublish_at were present in the body
// so PATCH can distinguish "clear the schedule" (field = null) from "leave it"
// (field absent). Mirrors suppressions.patchExpiresAtInput.
func (in *UpdateInput) UnmarshalJSON(b []byte) error {
	type alias UpdateInput // no UnmarshalJSON on alias — avoids recursion
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	*in = UpdateInput(a)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	_, in.HasPublishAt = raw["publish_at"]
	_, in.HasUnpublishAt = raw["unpublish_at"]
	return nil
}

// Errors.
var (
	ErrNotFound     = errors.New("landingpages: not found")
	ErrSlugConflict = errors.New("landingpages: slug already in use for this tenant")
	ErrInvalidSlug  = errors.New("landingpages: slug must be lowercase alphanumeric or dashes")
)

// MaxSlugLength caps the slug. Slugs land in URLs; bound to prevent
// pathological values.
const MaxSlugLength = 64

// MaxNameLength caps the editor-visible name.
const MaxNameLength = 200

const landingPageJSONMaxBodyBytes int64 = 4 << 20 // 4 MiB

// slugRE matches lowercase alphanumeric + hyphen, must start with a letter.
var slugRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func validateSlug(s string) error {
	if !slugRE.MatchString(s) {
		return ErrInvalidSlug
	}
	if len(s) > MaxSlugLength {
		return fmt.Errorf("%w: max %d chars", ErrInvalidSlug, MaxSlugLength)
	}
	return nil
}

// Repo wraps the pgx pool with landing_pages CRUD. RLS forces tenant
// scope on every method via db.WithTenant.
type Repo struct {
	Pool *db.Pool
}

// List returns the tenant's landing pages newest-first.
func (r *Repo) List(ctx context.Context, tenantID string) ([]LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, slug::text, name, status,
       COALESCE(domain, ''), template, blocks, seo, tracking, metrics,
       created_at, updated_at, publish_at, unpublish_at
  FROM landing_pages
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LandingPage{}
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Get returns one page by id (tenant-scoped).
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug::text, name, status,
       COALESCE(domain, ''), template, blocks, seo, tracking, metrics,
       created_at, updated_at, publish_at, unpublish_at
  FROM landing_pages
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	p, err := scan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return p, tx.Commit(ctx)
}

// Create inserts a new landing page in 'draft'. Returns ErrSlugConflict
// (mapped to 409) when (tenant_id, slug) collides.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*LandingPage, error) {
	if err := validateSlug(in.Slug); err != nil {
		return nil, err
	}
	if in.Name == "" || len(in.Name) > MaxNameLength {
		return nil, fmt.Errorf("name required, max %d chars", MaxNameLength)
	}
	if in.Template == "" {
		in.Template = "signup"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	blocksJSON, _ := json.Marshal(nilSlice(in.Blocks))
	seoJSON, _ := json.Marshal(nilMap(in.SEO))
	trackingJSON, _ := json.Marshal(nilMap(in.Tracking))
	row := tx.QueryRow(ctx, `
INSERT INTO landing_pages
    (tenant_id, slug, name, status, domain, template, blocks, seo, tracking, publish_at, unpublish_at)
VALUES
    ($1::uuid, $2, $3, 'draft', NULLIF($4, ''), $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
RETURNING id::text, tenant_id::text, slug::text, name, status,
          COALESCE(domain, ''), template, blocks, seo, tracking, metrics,
          created_at, updated_at, publish_at, unpublish_at`,
		tenantID, in.Slug, in.Name, in.Domain, in.Template,
		string(blocksJSON), string(seoJSON), string(trackingJSON), in.PublishAt, in.UnpublishAt)
	p, err := scan(row)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	return p, tx.Commit(ctx)
}

// Update applies a partial patch.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*LandingPage, error) {
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
	}
	if in.Slug != nil {
		s := strings.TrimSpace(*in.Slug)
		if err := validateSlug(s); err != nil {
			return nil, err
		}
		cur.Slug = s
	}
	if in.Status != nil {
		switch *in.Status {
		case StatusDraft, StatusPublished, StatusArchived:
			cur.Status = *in.Status
		default:
			return nil, fmt.Errorf("status must be one of draft|published|archived")
		}
	}
	if in.Domain != nil {
		cur.Domain = strings.TrimSpace(*in.Domain)
	}
	if in.Template != nil {
		cur.Template = strings.TrimSpace(*in.Template)
	}
	if in.Blocks != nil {
		cur.Blocks = *in.Blocks
	}
	if in.SEO != nil {
		cur.SEO = *in.SEO
	}
	if in.Tracking != nil {
		cur.Tracking = *in.Tracking
	}
	// LAND-038: tri-state schedule fields (present-but-null clears, absent leaves).
	if in.HasPublishAt {
		cur.PublishAt = in.PublishAt
	}
	if in.HasUnpublishAt {
		cur.UnpublishAt = in.UnpublishAt
	}
	if cur.PublishAt != nil && cur.UnpublishAt != nil && !cur.PublishAt.Before(*cur.UnpublishAt) {
		return nil, fmt.Errorf("publish_at must be earlier than unpublish_at")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// LAND-039: snapshot the PRE-overwrite content into landing_page_versions
	// inside the same tx before the UPDATE, so history is captured atomically.
	if err := snapshotVersion(ctx, tx, tenantID, cur.ID); err != nil {
		return nil, err
	}
	blocksJSON, _ := json.Marshal(nilSlice(cur.Blocks))
	seoJSON, _ := json.Marshal(nilMap(cur.SEO))
	trackingJSON, _ := json.Marshal(nilMap(cur.Tracking))
	row := tx.QueryRow(ctx, `
UPDATE landing_pages SET
    name = $3,
    status = $4,
    domain = NULLIF($5, ''),
    template = $6,
    blocks = $7::jsonb,
    seo = $8::jsonb,
    tracking = $9::jsonb,
    slug = $10,
    publish_at = $11,
    unpublish_at = $12,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, slug::text, name, status,
          COALESCE(domain, ''), template, blocks, seo, tracking, metrics,
          created_at, updated_at, publish_at, unpublish_at`,
		tenantID, cur.ID, cur.Name, string(cur.Status), cur.Domain, cur.Template,
		string(blocksJSON), string(seoJSON), string(trackingJSON), cur.Slug,
		cur.PublishAt, cur.UnpublishAt)
	p, err := scan(row)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	return p, tx.Commit(ctx)
}

// Delete is a soft delete via status='archived'. We keep rows because
// deleting a page would also delete any historical metrics — surprising
// for the operator. Hard-delete via a separate purge endpoint when we
// build one.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE landing_pages SET status = 'archived', updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND status <> 'archived'`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Version is one point-in-time snapshot of a landing page's editable content
// (LAND-039). blocks/seo/tracking are omitted from the list projection (large)
// and only hydrated on restore.
type Version struct {
	VersionNo int       `json:"version_no"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"created_at"`
}

// snapshotVersion writes the CURRENT (pre-mutation) landing_pages row into
// landing_page_versions as the next version_no, within the caller's tx. A page
// with no row (already deleted) snapshots nothing. Shared by Update + Restore.
func snapshotVersion(ctx context.Context, tx pgx.Tx, tenantID, pageID string) error {
	_, err := tx.Exec(ctx, `
INSERT INTO landing_page_versions
    (tenant_id, page_id, version_no, name, status, slug, blocks, seo, tracking)
SELECT lp.tenant_id, lp.id,
       COALESCE((SELECT max(v.version_no) FROM landing_page_versions v
                  WHERE v.tenant_id = lp.tenant_id AND v.page_id = lp.id), 0) + 1,
       lp.name, lp.status, lp.slug, lp.blocks, lp.seo, lp.tracking
  FROM landing_pages lp
 WHERE lp.tenant_id = $1::uuid AND lp.id::text = $2`, tenantID, pageID)
	return err
}

// ListVersions returns a page's snapshots, newest first.
func (r *Repo) ListVersions(ctx context.Context, tenantID, pageID string) ([]Version, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT version_no, name, status, COALESCE(slug::text, ''), created_at
  FROM landing_page_versions
 WHERE tenant_id = $1::uuid AND page_id = $2::uuid
 ORDER BY version_no DESC
 LIMIT 100`, tenantID, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		if err := rows.Scan(&v.VersionNo, &v.Name, &v.Status, &v.Slug, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Restore rolls a page back to a prior version's content. It first snapshots
// the current content (so the restore is itself undoable), then overwrites the
// live row from the chosen version. Returns the restored page.
func (r *Repo) Restore(ctx context.Context, tenantID, pageID string, versionNo int) (*LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Snapshot current first so restoring is reversible.
	if err := snapshotVersion(ctx, tx, tenantID, pageID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE landing_pages lp SET
    name = v.name,
    status = v.status,
    blocks = v.blocks,
    seo = v.seo,
    tracking = v.tracking,
    updated_at = now()
  FROM landing_page_versions v
 WHERE lp.tenant_id = $1::uuid AND lp.id::text = $2
   AND v.tenant_id = lp.tenant_id AND v.page_id = lp.id AND v.version_no = $3
RETURNING lp.id::text, lp.tenant_id::text, lp.slug::text, lp.name, lp.status,
          COALESCE(lp.domain, ''), lp.template, lp.blocks, lp.seo, lp.tracking, lp.metrics,
          lp.created_at, lp.updated_at, lp.publish_at, lp.unpublish_at`, tenantID, pageID, versionNo)
	p, err := scan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return p, tx.Commit(ctx)
}

// Conversion is one lead captured on a landing page (LAND-022): the email
// plus any ambient metadata, ordered newest-first.
type Conversion struct {
	Email    string         `json:"email"`
	Metadata map[string]any `json:"metadata,omitempty"`
	At       time.Time      `json:"at"`
}

// ListConversions returns the tenant's landing-page conversion events for one
// page, newest first, from the shared growth_surface_events store (RLS-scoped).
func (r *Repo) ListConversions(ctx context.Context, tenantID, pageID string) ([]Conversion, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(email, ''), metadata, at
  FROM growth_surface_events
 WHERE tenant_id = $1::uuid
   AND surface_type = 'landing_page'
   AND surface_id::text = $2
   AND event_type = 'conversion'
 ORDER BY at DESC
 LIMIT 5000`, tenantID, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conversion{}
	for rows.Next() {
		var c Conversion
		var metaRaw []byte
		if err := rows.Scan(&c.Email, &metaRaw, &c.At); err != nil {
			return nil, err
		}
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &c.Metadata)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// rowScanner narrows pgx.Row + pgx.Rows so scan() can serve both.
type rowScanner interface {
	Scan(dest ...any) error
}

func scan(r rowScanner) (*LandingPage, error) {
	var p LandingPage
	var blocksRaw, seoRaw, trackingRaw, metricsRaw []byte
	if err := r.Scan(
		&p.ID, &p.TenantID, &p.Slug, &p.Name, &p.Status,
		&p.Domain, &p.Template,
		&blocksRaw, &seoRaw, &trackingRaw, &metricsRaw,
		&p.CreatedAt, &p.UpdatedAt, &p.PublishAt, &p.UnpublishAt,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(blocksRaw, &p.Blocks)
	_ = json.Unmarshal(seoRaw, &p.SEO)
	_ = json.Unmarshal(trackingRaw, &p.Tracking)
	_ = json.Unmarshal(metricsRaw, &p.Metrics)
	return &p, nil
}

func nilSlice(s []map[string]any) []map[string]any {
	if s == nil {
		return []map[string]any{}
	}
	return s
}

func nilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// ----------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------

// Deps bundles the dependencies handlers need.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// List GET /api/v1/landing-pages
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get GET /api/v1/landing-pages/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	p, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "landing page not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// emitAudit writes a typed landing_page audit row (LAND-039 activity trail) so
// the page's Activity panel can filter by resource_type + resource_id exactly,
// instead of scraping the generic AuditMiddleware rows (which carry an empty
// resource_id). Failures are logged and swallowed — a transient audit hiccup
// must never fail the underlying mutation. Uses a fresh ctx so a cancelled
// request can't abort the write, mirroring AuditMiddleware.
func (d *Deps) emitAudit(r *http.Request, tenantID, action, pageID string, metadata map[string]any) {
	meta := middleware.AuditMetaFromRequest(r)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenantID)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("landingpages: audit tx", "action", action, "err", err)
		}
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := db.Audit(ctx, tx, meta, action, "landing_page", pageID, metadata); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("landingpages: audit write", "action", action, "err", err)
		}
		return
	}
	_ = tx.Commit(ctx)
}

// Leads GET /api/v1/landing-pages/{id}/leads — conversions for one page
// (LAND-022).
func (d *Deps) Leads(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListConversions(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// LeadsCSV GET /api/v1/landing-pages/{id}/leads.csv — the same conversions as a
// downloadable CSV (LAND-022).
func (d *Deps) LeadsCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	rows, err := d.Repo.ListConversions(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="landing-page-leads.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"email", "converted_at", "metadata_json"})
	for _, c := range rows {
		meta, _ := json.Marshal(c.Metadata)
		_ = cw.Write([]string{c.Email, c.At.Format(time.RFC3339), string(meta)})
	}
	cw.Flush()
}

// Create POST /api/v1/landing-pages
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, landingPageJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Slug = strings.TrimSpace(in.Slug)
	in.Name = strings.TrimSpace(in.Name)
	p, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrSlugConflict):
			httperror.Write(w, http.StatusConflict, "slug_conflict",
				fmt.Sprintf("a landing page with slug %q already exists", in.Slug))
		case errors.Is(err, ErrInvalidSlug):
			httperror.WriteValidation(w, "invalid_input", err.Error())
		default:
			httperror.WriteValidation(w, "invalid_input", err.Error())
		}
		return
	}
	d.emitAudit(r, t.ID, "landing_page.create", p.ID, map[string]any{"name": p.Name, "slug": p.Slug})
	writeJSON(w, http.StatusCreated, p)
}

// Update PATCH /api/v1/landing-pages/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, landingPageJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	p, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "landing page not found")
			return
		}
		if errors.Is(err, ErrSlugConflict) {
			httperror.Write(w, http.StatusConflict, "slug_conflict", "that public landing-page slug is already published by another workspace")
			return
		}
		httperror.WriteValidation(w, "invalid_input", err.Error())
		return
	}
	// A status change (publish/unpublish) reads as a distinct verb in the trail.
	action := "landing_page.update"
	md := map[string]any{}
	if in.Status != nil {
		md["status"] = string(*in.Status)
		if *in.Status == StatusPublished {
			action = "landing_page.publish"
		} else if *in.Status == StatusDraft {
			action = "landing_page.unpublish"
		}
	}
	d.emitAudit(r, t.ID, action, id, md)
	writeJSON(w, http.StatusOK, p)
}

// Delete DELETE /api/v1/landing-pages/{id} — soft via archive.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "landing page not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emitAudit(r, t.ID, "landing_page.archive", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Versions GET /api/v1/landing-pages/{id}/versions — snapshot history (LAND-039).
func (d *Deps) Versions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListVersions(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// Restore POST /api/v1/landing-pages/{id}/versions/{version}/restore — roll the
// page back to a prior snapshot (LAND-039).
func (d *Deps) Restore(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	n, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || n < 1 {
		httperror.WriteValidation(w, "invalid_input", "version must be a positive integer")
		return
	}
	p, err := d.Repo.Restore(r.Context(), t.ID, chi.URLParam(r, "id"), n)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "landing page or version not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emitAudit(r, t.ID, "landing_page.restore", chi.URLParam(r, "id"), map[string]any{"version_no": n})
	writeJSON(w, http.StatusOK, p)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
