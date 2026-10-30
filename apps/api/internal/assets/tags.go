// SPDX-License-Identifier: AGPL-3.0-only
//
// Workstream 4 (Mailchimp parity polish) — asset tagging.
//
// Three endpoints sit on top of the existing assets surface:
//
//	GET    /api/v1/assets/{id}/tags         list tags for one asset
//	POST   /api/v1/assets/{id}/tags         add tag(s); accepts {"tag":"x"}
//	                                        or {"tags":["x","y"]}; idempotent
//	DELETE /api/v1/assets/{id}/tags/{tag}   remove a single tag
//
// Plus a tenant-wide enumerator the toolbar chip-row uses:
//
//	GET    /api/v1/assets/tags              {tags:[{tag, count}, ...]}
//
// The List handler in repo.go also gains an optional `tag` filter — passing
// ?tag=foo intersects the result set with assets that carry that tag.
package assets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AssetTag is the per-asset projection.
type AssetTag struct {
	Tag string `json:"tag"`
}

// TagCount is the toolbar chip-row projection.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

const (
	maxTagLen          = 64
	assetTagsMaxBody   = 8 * 1024
	maxTagsPerRequest  = 32
	tenantTagListLimit = 200
)

func normalizeTag(in string) string {
	t := strings.ToLower(strings.TrimSpace(in))
	if !utf8.ValidString(t) || utf8.RuneCountInString(t) > maxTagLen {
		return ""
	}
	// Keep Unicode letters, numbers and combining marks plus the small set of
	// separators supported by the chip UI. This preserves multilingual tags
	// instead of silently replacing every non-ASCII character with a dash.
	var b strings.Builder
	for _, r := range t {
		switch {
		case unicode.IsLetter(r), unicode.IsNumber(r), unicode.IsMark(r), r == '-', r == '_', r == ' ':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	collapsed := strings.Join(strings.Fields(b.String()), " ")
	return strings.Trim(collapsed, "- ")
}

func validTagInput(in string) bool {
	t := strings.TrimSpace(in)
	return utf8.ValidString(t) && utf8.RuneCountInString(t) <= maxTagLen && normalizeTag(t) != ""
}

// ListTagsForAsset returns the (de-duplicated, lowercase) tags for one asset.
func (r *Repo) ListTagsForAsset(ctx context.Context, tenantID, assetID string) ([]string, int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM assets WHERE id::text = $1 AND deleted_at IS NULL`, assetID,
	).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	rows, err := tx.Query(ctx, `
SELECT tag FROM asset_tags
 WHERE tenant_id = $1::uuid AND asset_id::text = $2
 ORDER BY tag ASC`, tenantID, assetID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, version, tx.Commit(ctx)
}

// AddTagsToAsset inserts (asset, tag) rows idempotently and returns the
// resulting tag set for the asset.
func (r *Repo) AddTagsToAsset(ctx context.Context, tenantID, assetID string, tags []string, expectedVersion int64) ([]string, int64, error) {
	if expectedVersion <= 0 {
		return nil, 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Ensure the asset exists before we touch the tag table — a missing
	// asset should 404, not silently insert orphan tags.
	var version int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM assets WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`,
		assetID,
	).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	if version != expectedVersion {
		return nil, 0, ErrStale
	}
	changed := false
	for _, raw := range tags {
		t := normalizeTag(raw)
		if t == "" {
			continue
		}
		tag, err := tx.Exec(ctx, `
INSERT INTO asset_tags (tenant_id, asset_id, tag)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (tenant_id, asset_id, tag) DO NOTHING`,
			tenantID, assetID, t)
		if err != nil {
			return nil, 0, err
		}
		changed = changed || tag.RowsAffected() > 0
	}
	if changed {
		if err := tx.QueryRow(ctx, `
UPDATE assets SET updated_at = now(), version = version + 1
 WHERE id::text = $1 AND deleted_at IS NULL AND version = $2
 RETURNING version`, assetID, expectedVersion).Scan(&version); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, 0, classifyAssetMutationMiss(ctx, tx, assetID)
			}
			return nil, 0, err
		}
	}
	rows, err := tx.Query(ctx, `
SELECT tag FROM asset_tags
 WHERE tenant_id = $1::uuid AND asset_id = $2::uuid
 ORDER BY tag ASC`, tenantID, assetID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, version, tx.Commit(ctx)
}

// RemoveTagFromAsset deletes one (asset, tag) row.
func (r *Repo) RemoveTagFromAsset(ctx context.Context, tenantID, assetID, tag string, expectedVersion int64) (int64, error) {
	if expectedVersion <= 0 {
		return 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM assets WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, assetID,
	).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if version != expectedVersion {
		return 0, ErrStale
	}
	t := normalizeTag(tag)
	if t == "" {
		return version, tx.Commit(ctx)
	}
	command, err := tx.Exec(ctx, `
DELETE FROM asset_tags
 WHERE tenant_id = $1::uuid AND asset_id = $2::uuid AND tag = $3`,
		tenantID, assetID, t)
	if err != nil {
		return 0, err
	}
	if command.RowsAffected() > 0 {
		if err := tx.QueryRow(ctx, `
UPDATE assets SET updated_at = now(), version = version + 1
 WHERE id::text = $1 AND deleted_at IS NULL AND version = $2
 RETURNING version`, assetID, expectedVersion).Scan(&version); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, classifyAssetMutationMiss(ctx, tx, assetID)
			}
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return version, nil
}

// ListTenantTagsWithCounts returns the toolbar chip-row data:
// distinct tags across all of a tenant's live assets + per-tag counts.
func (r *Repo) ListTenantTagsWithCounts(ctx context.Context, tenantID string) ([]TagCount, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT at.tag, COUNT(*)
  FROM asset_tags at
  JOIN assets a ON a.id = at.asset_id AND a.deleted_at IS NULL
 WHERE at.tenant_id = $1::uuid
 GROUP BY at.tag
 ORDER BY COUNT(*) DESC, at.tag ASC
 LIMIT $2`, tenantID, tenantTagListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.Tag, &tc.Count); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				break
			}
			return nil, err
		}
		out = append(out, tc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// MountTagRoutes registers the tag-CRUD endpoints. Called from the same
// MountRoutes block in handlers.go so the scopes match the parent
// surface (writes need write_campaigns; reads need read_campaigns).
func (d *Deps) MountTagRoutes(r chi.Router) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.Get("/api/v1/assets/tags", d.ListTenantTags)
	r.Get("/api/v1/assets/{id}/tags", d.GetTags)
	r.Post("/api/v1/assets/{id}/tags", d.AddTags)
	r.Delete("/api/v1/assets/{id}/tags/{tag}", d.RemoveTag)
}

func (d *Deps) ListTenantTags(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tags, err := d.Repo.ListTenantTagsWithCounts(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (d *Deps) GetTags(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "asset id must be a canonical lowercase UUID")
		return
	}
	tags, version, err := d.Repo.ListTagsForAsset(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags, "version": version})
}

func (d *Deps) AddTags(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "asset id must be a canonical lowercase UUID")
		return
	}
	var in struct {
		Tag             *string   `json:"tag"`
		Tags            *[]string `json:"tags"`
		ExpectedVersion *int64    `json:"expected_version"`
	}
	if err := httpbody.DecodeJSON(w, r, assetTagsMaxBody, &in); err != nil {
		// httpbody errors are pre-shaped client-input errors with stable
		// codes (bad_json, body_too_large, etc.) — safe to surface their
		// .Error() text; not raw pgx/DB text.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if (in.Tag == nil) == (in.Tags == nil) {
		httperror.Write(w, http.StatusBadRequest, "invalid_tag_body", "supply exactly one of `tag` or `tags`")
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		httperror.Write(w, http.StatusPreconditionRequired, "expected_version_required", "expected_version must be a positive integer")
		return
	}
	var tags []string
	if in.Tags != nil {
		tags = append(tags, (*in.Tags)...)
	} else {
		tags = append(tags, *in.Tag)
	}
	if len(tags) == 0 {
		httperror.Write(w, http.StatusBadRequest, "missing_tag", "supply `tag` or `tags`")
		return
	}
	if len(tags) > maxTagsPerRequest {
		httperror.Write(w, http.StatusBadRequest, "too_many_tags", "max 32 tags per request")
		return
	}
	for _, raw := range tags {
		if !validTagInput(raw) {
			httperror.Write(w, http.StatusBadRequest, "invalid_tag", "tags must be 1 to 64 valid characters")
			return
		}
	}
	out, version, err := d.Repo.AddTagsToAsset(r.Context(), t.ID, id, tags, *in.ExpectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrStale):
			httperror.Write(w, http.StatusPreconditionFailed, "stale_version", "asset changed after it was read")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": out, "version": version})
}

func (d *Deps) RemoveTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tag := chi.URLParam(r, "tag")
	if !isCanonicalAssetUUID(id) {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "asset id must be a canonical lowercase UUID")
		return
	}
	expectedVersion, ok := readExpectedVersionBody(w, r, assetTagsMaxBody)
	if !ok {
		return
	}
	version, err := d.Repo.RemoveTagFromAsset(r.Context(), t.ID, id, tag, expectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrStale):
			httperror.Write(w, http.StatusPreconditionFailed, "stale_version", "asset changed after it was read")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version})
}

// keep json import live in single-file builds.
var _ = json.Marshal
