// SPDX-License-Identifier: AGPL-3.0-only
//
// Mailchimp-parity follow-up to Workstream 4 (asset tagging): asset
// folders. Tags are noisy ad-hoc labels; folders are a flat, structured
// "bucket" model — every asset belongs to zero or one folder, and the
// library toolbar chip-row lets operators filter to one folder at a
// time. Mirrors the campaign_folders shape from migration 0227 so the
// admin mental model stays consistent across the platform.
//
// Routes (mounted via MountFolderRoutes from main.go alongside
// MountRoutes):
//
//	GET    /api/v1/assets/folders          list folders + asset counts
//	POST   /api/v1/assets/folders          create folder; body {"name":"x"}
//	PATCH  /api/v1/assets/folders/{id}     rename folder; body {"name":"x"}
//	DELETE /api/v1/assets/folders/{id}     delete folder; assets inside
//	                                       fall back to folder_id NULL
//	                                       (the "Uncategorised" bucket)
//	PATCH  /api/v1/assets/{id}/folder      move asset; body
//	                                       {"folder_id": "uuid" | null}
//
// The List handler in repo.go also gains an optional `FolderID` filter:
// ?folder_id=<uuid> scopes to that folder, ?folder_id=root scopes to
// the uncategorised bucket (assets with folder_id IS NULL).
package assets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Folder is the public projection. Mirrors campaign_folders.Folder so the
// desktop client can reuse the same chip-row pattern.
type Folder struct {
	ID         string    `json:"id"`
	TenantID   string    `json:"tenantId"`
	Name       string    `json:"name"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Version    int64     `json:"version"`
	AssetCount int       `json:"assetCount"`
}

const (
	maxFolderNameLen   = 128
	folderBodyMax      = 8 * 1024
	folderListLimit    = 500
	folderRootSentinel = "root" // ?folder_id=root → assets with folder_id IS NULL
)

func normalizeFolderName(in string) string {
	n := strings.TrimSpace(in)
	if !utf8.ValidString(n) || utf8.RuneCountInString(n) > maxFolderNameLen {
		return ""
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 {
			return ""
		}
	}
	// Collapse internal whitespace runs — folder names rendered in chips
	// look broken when multi-space input sneaks through.
	n = strings.Join(strings.Fields(n), " ")
	return n
}

// ---------------------------------------------------------------------
// Repo methods
// ---------------------------------------------------------------------

// ListFolders returns the tenant's folders + per-folder asset count.
// Count is computed off the live (non-soft-deleted) asset set so the
// chip total matches the list the operator would see when filtering.
func (r *Repo) ListFolders(ctx context.Context, tenantID string) ([]Folder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT f.id::text, f.tenant_id::text, f.name, f.created_at, f.updated_at, f.version,
       COALESCE(c.cnt, 0) AS asset_count
  FROM asset_folders f
  LEFT JOIN (
    SELECT folder_id, COUNT(*) AS cnt
      FROM assets
     WHERE deleted_at IS NULL AND folder_id IS NOT NULL
     GROUP BY folder_id
  ) c ON c.folder_id = f.id
 WHERE f.tenant_id = $1::uuid
 ORDER BY f.created_at DESC
 LIMIT $2`, tenantID, folderListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt, &f.Version, &f.AssetCount); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateFolder inserts a new folder row. Duplicate names per tenant are
// rejected by the UNIQUE constraint; we surface that as ErrConflict
// rather than a generic 500.
func (r *Repo) CreateFolder(ctx context.Context, tenantID, name string) (*Folder, error) {
	n := normalizeFolderName(name)
	if n == "" {
		return nil, errEmptyFolderName
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var f Folder
	row := tx.QueryRow(ctx, `
INSERT INTO asset_folders (tenant_id, name)
VALUES ($1::uuid, $2)
RETURNING id::text, tenant_id::text, name, created_at, updated_at, version`, tenantID, n)
	if err := row.Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt, &f.Version); err != nil {
		// Treat duplicate-name as a conflict; the pgx unique-violation
		// SQLSTATE is 23505. We don't pull in the pgconn package just
		// for this — substring match on the error text is fine here.
		if isUniqueViolation(err) {
			return nil, ErrFolderConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// UpdateFolder renames a folder. Duplicate-name on the rename target is
// surfaced as ErrFolderConflict just like CreateFolder.
func (r *Repo) UpdateFolder(ctx context.Context, tenantID, id, name string, expectedVersion int64) (*Folder, error) {
	n := normalizeFolderName(name)
	if n == "" {
		return nil, errEmptyFolderName
	}
	if expectedVersion <= 0 {
		return nil, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var f Folder
	row := tx.QueryRow(ctx, `
UPDATE asset_folders
   SET name = $2, version = version + 1
 WHERE id::text = $1 AND version = $3
 RETURNING id::text, tenant_id::text, name, created_at, updated_at, version`, id, n, expectedVersion)
	if err := row.Scan(&f.ID, &f.TenantID, &f.Name, &f.CreatedAt, &f.UpdatedAt, &f.Version); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrFolderConflict
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, classifyFolderMutationMiss(ctx, tx, id)
		}
		return nil, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM assets WHERE folder_id::text = $1 AND deleted_at IS NULL`, id,
	).Scan(&f.AssetCount); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// DeleteFolder removes the folder row. The schema's ON DELETE SET NULL
// constraint on assets.folder_id falls back any contained assets to the
// uncategorised bucket automatically, but we issue an explicit UPDATE
// first so the two writes happen inside the same tx and the operator's
// list-view counts stay consistent if the DELETE fails halfway.
func (r *Repo) DeleteFolder(ctx context.Context, tenantID, id string, expectedVersion int64) (int64, error) {
	if expectedVersion <= 0 {
		return 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentVersion int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM asset_folders WHERE id::text = $1 FOR UPDATE`, id,
	).Scan(&currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if currentVersion != expectedVersion {
		return 0, ErrStale
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assets SET folder_id = NULL, updated_at = now(), version = version + 1
		  WHERE folder_id::text = $1 AND deleted_at IS NULL`, id); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM asset_folders WHERE id::text = $1`, id)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return currentVersion + 1, nil
}

// MoveAssetToFolder updates assets.folder_id. A nil folderID means
// "move to root" (Uncategorised); a non-nil pointer must reference a
// folder owned by the same tenant — the FK constraint enforces that
// across tenants too because RLS scopes the INSERT/UPDATE to the
// current tenant_id.
func (r *Repo) MoveAssetToFolder(ctx context.Context, tenantID, assetID string, folderID *string, expectedVersion int64) (int64, error) {
	if expectedVersion <= 0 {
		return 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentFolder *string
	var currentVersion int64
	if err := tx.QueryRow(ctx,
		`SELECT folder_id::text, version FROM assets WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, assetID,
	).Scan(&currentFolder, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if currentVersion != expectedVersion {
		return 0, ErrStale
	}
	var target *string
	if folderID == nil || *folderID == "" {
		target = nil
	} else {
		// Verify the target folder exists in the tenant scope before
		// the UPDATE — without this, a stale folder id surfaces as a
		// silent "rows affected = 0" and the UI's reassignment looks
		// like it succeeded. Explicit lookup → explicit ErrNotFound.
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM asset_folders WHERE id::text = $1)`,
			*folderID,
		).Scan(&exists); err != nil {
			return 0, err
		}
		if !exists {
			return 0, ErrFolderNotFound
		}
		v := *folderID
		target = &v
	}
	if equalOptionalString(currentFolder, target) {
		if err := tx.Commit(ctx); err != nil {
			return 0, err
		}
		return currentVersion, nil
	}
	var version int64
	if err := tx.QueryRow(ctx, `
UPDATE assets
   SET folder_id = $2::uuid, updated_at = now(), version = version + 1
 WHERE id::text = $1 AND deleted_at IS NULL AND version = $3
 RETURNING version`, assetID, target, expectedVersion).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, classifyAssetMutationMiss(ctx, tx, assetID)
		}
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return version, nil
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func classifyFolderMutationMiss(ctx context.Context, tx pgx.Tx, id string) error {
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM asset_folders WHERE id::text = $1)`, id,
	).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return ErrStale
}

// Sentinel errors specific to folder operations. ErrNotFound (defined in
// repo.go) is reused for "folder id doesn't exist".
var (
	ErrFolderConflict  = errors.New("assets: folder name already exists")
	ErrFolderNotFound  = errors.New("assets: target folder not found")
	errEmptyFolderName = errors.New("assets: folder name is required")
)

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// MountFolderRoutes registers the folder-CRUD endpoints + the per-asset
// move endpoint. Reads scope to read_campaigns (folders are part of
// the library view); writes to write_campaigns (matches the existing
// asset write gate).
func (d *Deps) MountFolderRoutes(r chi.Router) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/assets/folders", d.ListFolders)
	r.With(write).Post("/api/v1/assets/folders", d.CreateFolder)
	r.With(write).Patch("/api/v1/assets/folders/{id}", d.RenameFolder)
	r.With(write).Delete("/api/v1/assets/folders/{id}", d.DeleteFolder)
	r.With(write).Patch("/api/v1/assets/{id}/folder", d.MoveAsset)
}

func (d *Deps) ListFolders(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.ListFolders(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folders": out})
}

func (d *Deps) CreateFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in struct {
		Name            *string `json:"name"`
		ExpectedVersion *int64  `json:"expected_version"`
	}
	if err := httpbody.DecodeJSON(w, r, folderBodyMax, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Name == nil {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name is required"))
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion != 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be 0 for a folder create"))
		return
	}
	if !utf8.ValidString(*in.Name) || utf8.RuneCountInString(strings.TrimSpace(*in.Name)) > maxFolderNameLen {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_name", "name must be at most 128 valid characters"))
		return
	}
	f, err := d.Repo.CreateFolder(r.Context(), t.ID, *in.Name)
	if err != nil {
		switch {
		case errors.Is(err, errEmptyFolderName):
			writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name is required"))
		case errors.Is(err, ErrFolderConflict):
			writeJSON(w, http.StatusConflict, errEnv("name_conflict", "a folder with that name already exists"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

func (d *Deps) RenameFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "folder id must be a canonical lowercase UUID"))
		return
	}
	var in struct {
		Name            *string `json:"name"`
		ExpectedVersion *int64  `json:"expected_version"`
	}
	if err := httpbody.DecodeJSON(w, r, folderBodyMax, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Name == nil {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name is required"))
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return
	}
	if !utf8.ValidString(*in.Name) || utf8.RuneCountInString(strings.TrimSpace(*in.Name)) > maxFolderNameLen {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_name", "name must be at most 128 valid characters"))
		return
	}
	f, err := d.Repo.UpdateFolder(r.Context(), t.ID, id, *in.Name, *in.ExpectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, errEmptyFolderName):
			writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name is required"))
		case errors.Is(err, ErrFolderConflict):
			writeJSON(w, http.StatusConflict, errEnv("name_conflict", "a folder with that name already exists"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "folder changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (d *Deps) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "folder id must be a canonical lowercase UUID"))
		return
	}
	expectedVersion, ok := readExpectedVersionBody(w, r, folderBodyMax)
	if !ok {
		return
	}
	version, err := d.Repo.DeleteFolder(r.Context(), t.ID, id, expectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "folder changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version})
}

// MoveAsset PATCH /api/v1/assets/{id}/folder — body {"folder_id": "..."|null}.
// Explicit JSON null (or empty string, or `folder_id` omitted entirely)
// moves the asset back to the Uncategorised bucket.
func (d *Deps) MoveAsset(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	var in struct {
		FolderID        json.RawMessage `json:"folder_id"`
		ExpectedVersion *int64          `json:"expected_version"`
	}
	if err := httpbody.DecodeJSON(w, r, folderBodyMax, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.FolderID == nil {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_folder_id", "folder_id is required and may be null"))
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return
	}
	var target *string
	if string(in.FolderID) != "null" {
		var folderID string
		if err := json.Unmarshal(in.FolderID, &folderID); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_type", "folder_id must be a UUID string or null"))
			return
		}
		if strings.TrimSpace(folderID) != "" {
			v := strings.TrimSpace(folderID)
			if !isCanonicalAssetUUID(v) {
				writeJSON(w, http.StatusBadRequest, errEnv("invalid_folder_id", "folder_id must be a canonical lowercase UUID or null"))
				return
			}
			target = &v
		}
	}
	version, err := d.Repo.MoveAssetToFolder(r.Context(), t.ID, id, target, *in.ExpectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrFolderNotFound):
			writeJSON(w, http.StatusBadRequest, errEnv("folder_not_found", "target folder does not exist"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "asset changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version, "folderId": target})
}

// ---------------------------------------------------------------------
// ctx import — keep linker happy if the function bodies above are
// stubbed out during refactors.
// ---------------------------------------------------------------------
var _ context.Context = context.TODO()
