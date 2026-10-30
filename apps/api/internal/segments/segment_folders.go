// Segment folders — SUB-040. A flat (single-level) folder surface so
// operators can group saved-segment bookmarks under a named folder
// ("Lifecycle", "Win-back", ...). Distinct from pinning, which is the
// ad-hoc top-of-list affordance on the saved_segments rows themselves.
//
// Backed by migration 1237_segment_folders. saved_segments.folder_id is
// a nullable FK with ON DELETE SET NULL, so deleting a folder un-files
// (rather than deletes) its segments.
package segments

import (
	"context"
	"errors"
	"net/http"
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

const segmentFolderJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB

// SegmentFolder is the public projection of one segment_folders row.
type SegmentFolder struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SegmentFolderInput is the body of POST /segment-folders.
type SegmentFolderInput struct {
	Name string `json:"name"`
}

// SegmentFolderPatch is the body of PATCH /segment-folders/{id}.
type SegmentFolderPatch struct {
	Name *string `json:"name,omitempty"`
}

// MountFolderRoutes registers the segment-folder CRUD surface (SUB-040).
// Read scope for GET, write for mutating — mirrors the saved-segment
// routes.
func MountFolderRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/segment-folders", d.ListFolders)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/segment-folders", d.CreateFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/segment-folders/{id}", d.PatchFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/segment-folders/{id}", d.DeleteFolder)
}

/* ------------------------------ handlers --------------------------- */

// ListFolders GET /api/v1/segment-folders
func (d *Deps) ListFolders(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.ListFolders(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreateFolder POST /api/v1/segment-folders
func (d *Deps) CreateFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in SegmentFolderInput
	if err := httpbody.DecodeJSON(w, r, segmentFolderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_name", "name required")
		return
	}
	out, err := d.Repo.CreateFolder(r.Context(), t.ID, name)
	if err != nil {
		if errors.Is(err, ErrFolderNameConflict) {
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// PatchFolder PATCH /api/v1/segment-folders/{id}
func (d *Deps) PatchFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "folder id required")
		return
	}
	var in SegmentFolderPatch
	if err := httpbody.DecodeJSON(w, r, segmentFolderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Name == nil {
		httperror.Write(w, http.StatusBadRequest, "missing_name", "name required")
		return
	}
	name := strings.TrimSpace(*in.Name)
	if name == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_name", "name required")
		return
	}
	out, err := d.Repo.PatchFolder(r.Context(), t.ID, id, name)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such folder"))
		case errors.Is(err, ErrFolderNameConflict):
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteFolder DELETE /api/v1/segment-folders/{id}. Deleting a folder
// un-files (does not delete) its saved segments via the FK's ON DELETE
// SET NULL.
func (d *Deps) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if err := d.Repo.DeleteFolder(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* ------- repo methods (segment_folders table) --------------------- */

// ListFolders returns all folders for the tenant, name-sorted.
func (r *Repo) ListFolders(ctx context.Context, tenantID string) ([]SegmentFolder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, created_at, updated_at
  FROM segment_folders
 WHERE tenant_id = $1::uuid
 ORDER BY name ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SegmentFolder{}
	for rows.Next() {
		var f SegmentFolder
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateFolder inserts a new folder. Returns ErrFolderNameConflict on a
// (tenant_id, name) collision.
func (r *Repo) CreateFolder(ctx context.Context, tenantID, name string) (*SegmentFolder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var f SegmentFolder
	err = tx.QueryRow(ctx, `
INSERT INTO segment_folders (tenant_id, name)
VALUES ($1::uuid, $2)
RETURNING id::text, tenant_id::text, name, created_at, updated_at`,
		tenantID, name).
		Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrFolderNameConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// PatchFolder renames a folder. Returns ErrNotFound when the id is
// unknown for the tenant, ErrFolderNameConflict on a name collision.
func (r *Repo) PatchFolder(ctx context.Context, tenantID, id, name string) (*SegmentFolder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var f SegmentFolder
	err = tx.QueryRow(ctx, `
UPDATE segment_folders
   SET name = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, name, created_at, updated_at`,
		tenantID, id, name).
		Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if isUniqueViolation(err) {
			return nil, ErrFolderNameConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// DeleteFolder removes a folder. The FK on saved_segments.folder_id is
// ON DELETE SET NULL, so member segments are un-filed, not deleted.
func (r *Repo) DeleteFolder(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM segment_folders WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
