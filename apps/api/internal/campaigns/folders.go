package campaigns

// folders.go — Workstream 2 (A): campaign folder CRUD + a
// "move campaign into folder" affordance. The repo lives next to the
// regular campaigns.Repo so handlers can share the same Deps wiring;
// migration 0227 owns the schema (`campaign_folders` + the new
// `folder_id` column on `campaigns`).
//
// Mailchimp parity here is deliberately narrow: folders are a flat list
// per workspace (no nesting), a campaign can live in 0 or 1 folder, and
// the "uncategorised" bucket is just folder_id IS NULL. Anything fancier
// (shared folders, per-folder permissions, sorting) is out of scope for
// the polish push.

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

const folderJSONMaxBodyBytes int64 = 4 << 10 // 4 KiB

// Folder is the per-tenant grouping a campaign can be filed into.
// Mirrors the `campaign_folders` row. CampaignCount is a denormalised
// count returned by List so the UI can show "Drafts (12)" without a
// second round-trip per folder.
type Folder struct {
	ID            string    `json:"id"`
	TenantID      string    `json:"tenant_id"`
	Name          string    `json:"name"`
	CampaignCount int       `json:"campaign_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// FolderInput is the request body for create + patch. Name is required
// on create; patch ignores empty.
type FolderInput struct {
	Name string `json:"name"`
}

// MoveFolderInput is the request body for PATCH /campaigns/{id}/folder.
// Empty string / null moves the campaign back to "uncategorised".
type MoveFolderInput struct {
	FolderID string `json:"folder_id"`
}

// ErrFolderNotFound is returned when a folder lookup misses for the
// requesting tenant. The handler surfaces this as a 404.
var ErrFolderNotFound = errors.New("campaign folder not found")

// MountFolders registers the folder CRUD + the "move campaign" pivot.
// Mounted separately from the canonical read/write surface so existing
// callers stay untouched.
func MountFolders(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/folders", d.ListFolders)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/folders", d.CreateFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Patch("/api/v1/campaigns/folders/{id}", d.UpdateFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/campaigns/folders/{id}", d.DeleteFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Patch("/api/v1/campaigns/{id}/folder", d.MoveCampaignToFolder)
}

// ---- handlers --------------------------------------------------------

func (d *Deps) ListFolders(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rows, err := d.Repo.ListFolders(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows})
}

func (d *Deps) CreateFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in FolderInput
	if err := httpbody.DecodeJSON(w, r, folderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name is required"))
		return
	}
	folder, err := d.Repo.CreateFolder(r.Context(), t.ID, in.Name)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, folder)
}

func (d *Deps) UpdateFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in FolderInput
	if err := httpbody.DecodeJSON(w, r, folderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name is required"))
		return
	}
	folder, err := d.Repo.UpdateFolder(r.Context(), t.ID, chi.URLParam(r, "id"), in.Name)
	if err != nil {
		if errors.Is(err, ErrFolderNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "folder not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (d *Deps) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.Repo.DeleteFolder(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrFolderNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "folder not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) MoveCampaignToFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in MoveFolderInput
	if err := httpbody.DecodeJSON(w, r, folderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := d.Repo.MoveCampaignToFolder(r.Context(), t.ID, chi.URLParam(r, "id"), strings.TrimSpace(in.FolderID)); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		if errors.Is(err, ErrFolderNotFound) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("folder_not_found", "folder not found for tenant"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "folder_id": in.FolderID})
}

// ---- repo methods ----------------------------------------------------

// ListFolders returns all folders for the tenant plus their denormalised
// campaign counts. Cheap subquery scan — fine for the dozen-or-so
// folders a workspace will have in practice.
func (r *Repo) ListFolders(ctx context.Context, tenantID string) ([]Folder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT f.id::text,
       f.tenant_id::text,
       f.name,
       (SELECT count(*)::int
          FROM campaigns c
         WHERE c.tenant_id = f.tenant_id
           AND c.folder_id = f.id) AS campaign_count,
       f.created_at,
       f.updated_at
  FROM campaign_folders f
 WHERE f.tenant_id = $1::uuid
 ORDER BY lower(f.name)`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Name, &f.CampaignCount, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateFolder inserts a folder. Duplicate-name within a tenant returns
// the existing row (idempotent on a name retry) — matches the
// "create or reuse" expectations of the rename flow in the UI.
func (r *Repo) CreateFolder(ctx context.Context, tenantID, name string) (*Folder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_folders (tenant_id, name)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
RETURNING id::text`, tenantID, name).Scan(&id)
	if err != nil {
		return nil, err
	}
	folder, err := queryFolderTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return folder, nil
}

// UpdateFolder renames a folder. Hits ErrFolderNotFound when the row
// doesn't exist for the tenant.
func (r *Repo) UpdateFolder(ctx context.Context, tenantID, id, name string) (*Folder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_folders
   SET name = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, name)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrFolderNotFound
	}
	folder, err := queryFolderTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return folder, nil
}

// DeleteFolder removes a folder. Campaigns inside the folder are left
// behind with folder_id reset to NULL (the migration's ON DELETE SET
// NULL clause handles this).
func (r *Repo) DeleteFolder(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM campaign_folders WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrFolderNotFound
	}
	return tx.Commit(ctx)
}

// MoveCampaignToFolder pivots a campaign into a folder. Empty folderID
// = move to uncategorised (NULL). Validates the folder belongs to the
// requesting tenant before flipping.
func (r *Repo) MoveCampaignToFolder(ctx context.Context, tenantID, campaignID, folderID string) error {
	folderID = strings.TrimSpace(folderID)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if folderID != "" {
		var ok bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM campaign_folders
   WHERE tenant_id = $1::uuid AND id::text = $2
)`, tenantID, folderID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrFolderNotFound
		}
	}
	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET folder_id = NULLIF($3, '')::uuid, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, campaignID, folderID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func queryFolderTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Folder, error) {
	var f Folder
	err := tx.QueryRow(ctx, `
SELECT f.id::text,
       f.tenant_id::text,
       f.name,
       (SELECT count(*)::int
          FROM campaigns c
         WHERE c.tenant_id = f.tenant_id AND c.folder_id = f.id) AS campaign_count,
       f.created_at,
       f.updated_at
  FROM campaign_folders f
 WHERE f.tenant_id = $1::uuid AND f.id::text = $2`,
		tenantID, id).Scan(&f.ID, &f.TenantID, &f.Name, &f.CampaignCount, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, err
	}
	return &f, nil
}
