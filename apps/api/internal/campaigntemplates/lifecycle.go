// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultTemplateRevisionPageSize = 20
	maxTemplateRevisionPageSize     = 50
)

// TemplateRevisionSummary is the compact revision-history projection. The
// immutable snapshot is fetched only when a caller selects one revision.
type TemplateRevisionSummary struct {
	Version      int64      `json:"version"`
	ETag         string     `json:"etag"`
	Transition   string     `json:"transition"`
	Name         string     `json:"name"`
	Subject      string     `json:"subject"`
	ArchivedAt   *time.Time `json:"archived_at,omitempty"`
	SnapshotTime time.Time  `json:"snapshot_time"`
	// ChangedByEmail identifies who made the edit that produced this
	// revision (TMPL-040); empty when the actor wasn't recorded.
	ChangedByEmail string `json:"changed_by_email,omitempty"`
}

type TemplateRevisionPage struct {
	Items   []TemplateRevisionSummary `json:"items"`
	Page    int                       `json:"page"`
	PerPage int                       `json:"per_page"`
	Total   int                       `json:"total"`
}

type TemplateRevision struct {
	Version      int64     `json:"version"`
	ETag         string    `json:"etag"`
	Transition   string    `json:"transition"`
	SnapshotTime time.Time `json:"snapshot_time"`
	Snapshot     Template  `json:"snapshot"`
}

func templateETag(template *Template) string {
	if template == nil || strings.TrimSpace(template.ID) == "" || template.Version < 1 {
		return ""
	}
	return httpcache.ETagStrong("campaign-template", template.ID, template.Version)
}

// requireTemplateIfMatch accepts exactly one strong entity tag. Missing and
// wildcard headers cannot guard a write and produce 428; malformed/weak/multi
// value headers are present but can never match and produce 412.
func requireTemplateIfMatch(w http.ResponseWriter, r *http.Request) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	raw := strings.TrimSpace(values[0])
	if raw == "" || raw == "*" {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	if len(values) != 1 || strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") ||
		len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		httpcache.WritePreconditionFailed(w)
		return "", false
	}
	return raw, true
}

func (r *Repo) Archive(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return r.setArchived(ctx, tenantID, id, ifMatch, true)
}

func (r *Repo) Restore(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return r.setArchived(ctx, tenantID, id, ifMatch, false)
}

func (r *Repo) setArchived(ctx context.Context, tenantID, id, ifMatch string, archived bool) (*Template, error) {
	current, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if current.TenantID == "" {
		return nil, ErrNotFound
	}
	if current.TemplateKind == templateKindReference {
		return nil, ErrReferenceDeleteBlocked
	}
	if ifMatch == "" || ifMatch != templateETag(current) {
		return nil, ErrTemplatePrecondition
	}
	if (current.ArchivedAt != nil) == archived {
		return current, nil
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var archivedAt any
	if archived {
		archivedAt = time.Now().UTC()
	}
	row := tx.QueryRow(ctx, `
UPDATE campaign_templates
   SET archived_at = $4::timestamptz,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND version = $3
RETURNING id::text, COALESCE(tenant_id::text, ''), slug, name,
          COALESCE(description, ''), COALESCE(category, ''),
          subject, preview_text, body_html, body_mjml,
          variables, tags, created_at, updated_at,
          COALESCE(goal, ''), COALESCE(is_featured, false),
          COALESCE(usage_count, 0), last_used_at,
          false AS is_favorited,
          template_kind, source_provider, COALESCE(source_external_id, ''),
          source_url, source_brand, thumbnail_url, source_captured_at,
          source_license_status, source_metadata, industry, style, layout,
          design_metadata, review_status, quality_score::float8, content_hash,
          imported_at, COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
          generation_metadata,
          reference_adaptation_allowed, reference_direct_use_allowed,
          COALESCE(reference_review_decision_id::text, ''),
          reference_reviewed_at,
          (body_html <> '') AS has_source_html,
          (body_mjml <> '') AS has_source_mjml,
          version, archived_at`,
		tenantID, current.ID, current.Version, archivedAt)
	updated, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTemplatePrecondition
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

func (r *Repo) ListRevisions(
	ctx context.Context,
	tenantID, id string,
	page, perPage int,
) (*TemplateRevisionPage, error) {
	template, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if template.TenantID == "" {
		return nil, ErrNotFound
	}
	if template.TemplateKind != templateKindEditable {
		return nil, ErrReferenceMutationBlocked
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = defaultTemplateRevisionPageSize
	}
	if perPage > maxTemplateRevisionPageSize {
		perPage = maxTemplateRevisionPageSize
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &TemplateRevisionPage{
		Items: []TemplateRevisionSummary{}, Page: page, PerPage: perPage,
	}
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int
  FROM campaign_template_revisions
 WHERE tenant_id = $1::uuid
   AND template_id = $2::uuid`,
		tenantID, template.ID,
	).Scan(&out.Total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT revision.version, revision.transition,
       COALESCE(revision.snapshot->>'name', ''),
       COALESCE(revision.snapshot->>'subject', ''),
       revision.archived_at, revision.created_at,
       COALESCE(u.email, '')
  FROM campaign_template_revisions revision
  LEFT JOIN users u ON u.id = revision.changed_by_user_id
 WHERE revision.tenant_id = $1::uuid
   AND revision.template_id = $2::uuid
 ORDER BY revision.version DESC
 LIMIT $3 OFFSET $4`, tenantID, template.ID, perPage, (page-1)*perPage)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item TemplateRevisionSummary
		if err := rows.Scan(
			&item.Version, &item.Transition, &item.Name, &item.Subject,
			&item.ArchivedAt, &item.SnapshotTime, &item.ChangedByEmail,
		); err != nil {
			return nil, err
		}
		item.ETag = httpcache.ETagStrong("campaign-template", template.ID, item.Version)
		out.Items = append(out.Items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetRevision(ctx context.Context, tenantID, id string, version int64) (*TemplateRevision, error) {
	if version < 1 {
		return nil, ErrNotFound
	}
	template, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if template.TenantID == "" {
		return nil, ErrNotFound
	}
	if template.TemplateKind != templateKindEditable {
		return nil, ErrReferenceMutationBlocked
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var transition string
	var snapshotTime time.Time
	var raw []byte
	err = tx.QueryRow(ctx, `
SELECT transition, snapshot, created_at
  FROM campaign_template_revisions
 WHERE tenant_id = $1::uuid
   AND template_id = $2::uuid
   AND version = $3`, tenantID, template.ID, version).Scan(&transition, &raw, &snapshotTime)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var snapshot Template
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, err
	}
	snapshot.PreviewAssets = []TemplatePreviewAsset{}
	projectTemplate(&snapshot, unrestrictedTemplatePresentation)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	etag := httpcache.ETagStrong("campaign-template", template.ID, version)
	return &TemplateRevision{
		Version: version, ETag: etag, Transition: transition,
		SnapshotTime: snapshotTime, Snapshot: snapshot,
	}, nil
}

// RestoreRevision overwrites a template's editable content with an earlier
// revision's snapshot (TMPL-040). It routes through Update, so the restore is
// itself recorded as a new revision (the pre-restore state is never lost) and
// all Update guards (reference/archived/precondition) apply. The current ETag
// is supplied so the optimistic-concurrency precondition is satisfied.
func (r *Repo) RestoreRevision(ctx context.Context, tenantID, id string, version int64, actorUserID string) (*Template, error) {
	rev, err := r.GetRevision(ctx, tenantID, id, version)
	if err != nil {
		return nil, err
	}
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	s := rev.Snapshot
	// Non-nil base so a tagless snapshot restores to '{}' not NULL (tags is
	// NOT NULL). Update's nilSlice/nonNilObject cover variables/design.
	tags := append([]string{}, s.Tags...)
	vars := s.Variables
	design := s.DesignMetadata
	in := UpdateInput{
		ActorUserID:    actorUserID,
		Name:           &s.Name,
		Description:    &s.Description,
		Category:       &s.Category,
		Subject:        &s.Subject,
		PreviewText:    &s.PreviewText,
		BodyHTML:       &s.BodyHTML,
		BodyMJML:       &s.BodyMJML,
		Variables:      &vars,
		Tags:           &tags,
		Goal:           &s.Goal,
		Industry:       &s.Industry,
		Style:          &s.Style,
		Layout:         &s.Layout,
		ThumbnailURL:   &s.ThumbnailURL,
		DesignMetadata: &design,
		IfMatch:        templateETag(cur),
	}
	return r.Update(ctx, tenantID, id, in)
}

// RestoreRevision POST /api/v1/campaign-templates/{id}/revisions/{version}/restore.
func (d *Deps) RestoreRevision(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	version, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 64)
	if err != nil || version < 1 {
		httperror.Write(w, http.StatusBadRequest, "invalid_version",
			"version must be a positive integer")
		return
	}
	actor := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		actor = u.ID
	}
	tpl, err := d.Repo.RestoreRevision(r.Context(), t.ID, chi.URLParam(r, "id"), version, actor)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrReferenceMutationBlocked):
			httperror.Write(w, http.StatusUnprocessableEntity, "adaptation_required",
				"Reference templates are read-only.")
		case errors.Is(err, ErrTemplateArchived):
			httperror.Write(w, http.StatusConflict, "template_archived",
				"Restore the template before editing it.")
		case errors.Is(err, ErrTemplatePrecondition):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	w.Header().Set("ETag", tpl.ETag)
	writeJSON(w, http.StatusOK, tpl)
}

func (d *Deps) Archive(w http.ResponseWriter, r *http.Request) {
	d.setArchived(w, r, true)
}

func (d *Deps) Restore(w http.ResponseWriter, r *http.Request) {
	d.setArchived(w, r, false)
}

func (d *Deps) setArchived(w http.ResponseWriter, r *http.Request, archived bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	ifMatch, ok := requireTemplateIfMatch(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	var template *Template
	var err error
	if archived {
		template, err = d.Repo.Archive(r.Context(), tenant.ID, id, ifMatch)
	} else {
		template, err = d.Repo.Restore(r.Context(), tenant.ID, id, ifMatch)
	}
	if err != nil {
		writeTemplateLifecycleError(w, r, d, err)
		return
	}
	projectTemplateForRequest(r.Context(), template)
	w.Header().Set("ETag", template.ETag)
	writeJSON(w, http.StatusOK, template)
}

func (d *Deps) ListRevisions(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	out, err := d.Repo.ListRevisions(
		r.Context(), tenant.ID, chi.URLParam(r, "id"),
		intQuery(r.URL.Query().Get("page"), 1),
		intQuery(r.URL.Query().Get("per_page"), defaultTemplateRevisionPageSize),
	)
	if err != nil {
		writeTemplateLifecycleError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetRevision(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	version, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 64)
	if err != nil || version < 1 {
		httperror.Write(w, http.StatusNotFound, "not_found", "")
		return
	}
	out, err := d.Repo.GetRevision(r.Context(), tenant.ID, chi.URLParam(r, "id"), version)
	if err != nil {
		writeTemplateLifecycleError(w, r, d, err)
		return
	}
	projectTemplateForRequest(r.Context(), &out.Snapshot)
	w.Header().Set("ETag", out.ETag)
	writeJSON(w, http.StatusOK, out)
}

func writeTemplateLifecycleError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrTemplatePrecondition):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrTemplateArchived):
		httperror.Write(w, http.StatusConflict, "template_archived",
			"Restore the template before editing it.")
	case errors.Is(err, ErrReferenceDeleteBlocked), errors.Is(err, ErrReferenceMutationBlocked):
		httperror.Write(w, http.StatusUnprocessableEntity, "reference_read_only",
			"Reference templates are immutable catalog records.")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}
