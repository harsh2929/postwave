// SPDX-License-Identifier: AGPL-3.0-only
//
// Package exports implements the async tenant data-export job.
//
// Endpoints (tenant-scoped, admin):
//
//   POST   /api/v1/exports        — queue a new export. Body:
//                                    { include: ["subscribers", ...] }
//                                    Returns { id, status: "queued" }.
//   GET    /api/v1/exports        — list this tenant's exports.
//   GET    /api/v1/exports/{id}   — read one. Once status='ready', an
//                                    authenticated download path is projected.
//   GET    /api/v1/exports/{id}/download — tenant-bound private ZIP stream.
//
// The Worker is started from main.go alongside the other background
// workers. On each tick it claims one 'queued' row at a time per
// tenant, runs the per-resource walks, uploads the bundle to object
// private storage and marks status='ready'. On failure the
// row goes to status='failed' with error captured.
//
// Supported include[] values (more can be added by extending
// walkResource):
//   "subscribers"  one JSONL file with every subscriber row
//   "campaigns"    one JSONL file with every campaign
//   "automations"  one JSONL file with every automation
//   "audit_log"    one JSONL file with the last 365 days of audit
//                   rows for the tenant
//   "lists"        one JSONL file with lists + memberships
//   "tags"         one JSONL file with tags + memberships
//   "events"       last 90 days of subscriber_events
//
// The whole bundle goes into a ZIP under the attempt-fenced object key
// `exports/<tenant>/<export_id>/<lease_id>.zip`. Pre-lease legacy keys remain
// readable only through the same tenant-bound route. Expiry is derived from
// the tenant's export_retention_policy immediately before upload.

package exports

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
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
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/operation"
)

// SupportedResources is the set of include[] values the worker
// understands. Adding to this list requires implementing the matching
// walkResource branch in worker.go.
var SupportedResources = []string{
	"subscribers", "campaigns", "automations", "audit_log",
	"lists", "tags", "events",
	// "Take everything" resources (no lock-in). Each is RLS-bound and
	// streamed; an absent/empty table degrades gracefully to an empty
	// (or note-only) file rather than failing the whole ZIP.
	"templates", "segments", "forms", "suppressions", "consent",
}

// Storage is the private object-storage contract for tenant exports. Export
// bundles contain a workspace's complete portable dataset, so they must never
// share the public asset/CDN sink. Callers receive only the authenticated
// tenant-bound download route; no bearer or public object URL is persisted.
type Storage interface {
	Put(ctx context.Context, key, contentType string, body io.Reader, size int64, sha256Hex string) error
	Open(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error)
	Stat(ctx context.Context, key string) (string, int64, string, error)
	Delete(ctx context.Context, key string) error
}

// Deps wires the handler + worker.
type Deps struct {
	Pool    *db.Pool
	Storage Storage
	// Logger is used by httperror.WriteInternal to record server-side
	// error details (tenant_id+request_id+err) without echoing them to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the tenant-facing endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/exports", d.Create)
	r.With(admin).Get("/api/v1/exports", d.List)
	r.With(admin).Get("/api/v1/exports/{id}", d.Get)
	r.With(admin).Get("/api/v1/exports/{id}/download", d.Download)
	r.With(admin).Head("/api/v1/exports/{id}/download", d.Download)
}

// createInput is the POST body.
type createInput struct {
	Include []string `json:"include"`
}

// Create POST /api/v1/exports.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Storage == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "export_storage_unavailable",
			"private export storage is not configured")
		return
	}
	u, _ := middleware.UserFromContext(r.Context())
	var in createInput
	r.Body = http.MaxBytesReader(w, r.Body, 4*1024)
	if err := httpbody.DecodeJSON(w, r, 4*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	// Validate include set.
	if len(in.Include) == 0 {
		// Default to everything supported when caller didn't specify.
		in.Include = append([]string{}, SupportedResources...)
	} else {
		seen := make(map[string]struct{}, len(in.Include))
		for _, name := range in.Include {
			if !isSupported(name) {
				httperror.WriteValidation(w, "invalid_request",
					"unknown include: "+name)
				return
			}
			if _, duplicate := seen[name]; duplicate {
				httperror.WriteValidation(w, "invalid_request", "include values must be unique")
				return
			}
			seen[name] = struct{}{}
		}
	}
	includeJSON, _ := json.Marshal(in.Include)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	maximum, active, err := lockRetentionCapacity(r.Context(), tx, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if active >= maximum {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{
				"code": "export_capacity_reached",
				"message": fmt.Sprintf(
					"this workspace already has %d queued, running, or ready exports; the configured maximum is %d",
					active,
					maximum,
				),
				"details": map[string]any{
					"active":  active,
					"maximum": maximum,
				},
			},
		})
		return
	}
	var id string
	var userID any
	var userEmail any
	if u != nil {
		if u.ID != "" {
			userID = u.ID
		}
		if u.Email != "" {
			userEmail = u.Email
		}
	}
	err = tx.QueryRow(r.Context(), `
INSERT INTO tenant_exports (tenant_id, requested_by, requested_by_email, include)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
RETURNING id::text`,
		t.ID, userID, userEmail, string(includeJSON)).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"id": id, "status": "queued", "state": canonicalExportState("queued"),
		"include": in.Include,
	})
}

// List GET /api/v1/exports.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text,
       CASE WHEN status = 'ready' AND expires_at <= now()
            THEN 'expired' ELSE status END,
	       include, requested_by_email,
	       COALESCE(bytes_total, 0), COALESCE(rows_total, 0),
	       object_key,
	       expires_at::text, error, created_at::text
  FROM tenant_exports
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 200`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id, status, createdAt                     string
			includeJSON                               []byte
			bytesTotal, rowsTotal                     int64
			requestedBy, objectKey, expiresAt, errMsg *string
		)
		if err := rows.Scan(&id, &status, &includeJSON, &requestedBy,
			&bytesTotal, &rowsTotal, &objectKey, &expiresAt, &errMsg, &createdAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		include, err := decodePersistedResourceSelection(includeJSON)
		if err != nil {
			httperror.WriteInternal(w, d.Logger,
				fmt.Errorf("export %s has an invalid persisted resource selection: %w", id, err),
				r.Context())
			return
		}
		downloadPath := exportDownloadPath(t.ID, id, status, objectKey, expiresAt)
		row := map[string]any{
			"id":     id,
			"status": status,
			// The canonical lifecycle position beside the family's own spelling.
			//
			// `tenant_exports` says `ready`; automation backfills say
			// `completed`; audit exports say `pending`/`in_progress`. A caller
			// building any cross-family view has to translate, and every caller
			// translating separately is how one idea acquires six vocabularies.
			// The raw `status` stays because it is the published contract.
			"state":              canonicalExportState(status),
			"include":            include,
			"requested_by_email": derefStr(requestedBy),
			"bytes_total":        bytesTotal,
			"rows_total":         rowsTotal,
			"download_url":       downloadPath,
			"download_path":      downloadPath,
			"expires_at":         derefStr(expiresAt),
			"error":              derefStr(errMsg),
			"created_at":         createdAt,
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exports": out})
}

// Get GET /api/v1/exports/{id}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	parsedID, parseErr := uuid.Parse(id)
	if parseErr != nil || parsedID.String() != id {
		writeJSONErr(w, http.StatusBadRequest, "invalid_id", "export id must be a canonical UUID")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		status, createdAt                         string
		includeJSON                               []byte
		bytesTotal, rowsTotal                     int64
		requestedBy, objectKey, expiresAt, errMsg *string
	)
	if err := tx.QueryRow(r.Context(), `
SELECT CASE WHEN status = 'ready' AND expires_at <= now()
            THEN 'expired' ELSE status END,
	       include, requested_by_email,
	       COALESCE(bytes_total, 0), COALESCE(rows_total, 0),
	       object_key,
	       expires_at::text, error, created_at::text
  FROM tenant_exports
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id).Scan(&status, &includeJSON, &requestedBy,
		&bytesTotal, &rowsTotal, &objectKey, &expiresAt, &errMsg, &createdAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "export not found")
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	include, err := decodePersistedResourceSelection(includeJSON)
	if err != nil {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("export %s has an invalid persisted resource selection: %w", id, err),
			r.Context())
		return
	}
	downloadPath := exportDownloadPath(t.ID, id, status, objectKey, expiresAt)
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id,
		// Both spellings, on every endpoint that reports a status. An earlier
		// version added `state` to List alone, which is the ONE endpoint a
		// poller does not use — the package header points callers at this one to
		// watch an export finish, so a caller building on `state` saw it
		// undefined on every poll.
		"status":             status,
		"state":              canonicalExportState(status),
		"include":            include,
		"requested_by_email": derefStr(requestedBy),
		"bytes_total":        bytesTotal,
		"rows_total":         rowsTotal,
		"download_url":       downloadPath,
		"download_path":      downloadPath,
		"expires_at":         derefStr(expiresAt),
		"error":              derefStr(errMsg),
		"created_at":         createdAt,
	})
}

// Download GET /api/v1/exports/{id}/download streams a private export after a
// fresh tenant/status/expiry check. The route is admin scoped and step-up
// protected by the global policy. Object keys and storage URLs never leave the
// service boundary.
func (d *Deps) Download(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Pool == nil || d.Storage == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "export_storage_unavailable",
			"private export storage is not configured")
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	parsedID, err := uuid.Parse(id)
	if err != nil || parsedID.String() != id {
		writeJSONErr(w, http.StatusBadRequest, "invalid_id", "export id must be a canonical UUID")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		status     string
		objectKey  *string
		bundleSHA  *string
		expiresAt  *time.Time
		bytesTotal int64
	)
	err = tx.QueryRow(r.Context(), `
SELECT status, object_key, bundle_sha256, expires_at, COALESCE(bytes_total, 0)
  FROM tenant_exports
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenant.ID, id,
	).Scan(&status, &objectKey, &bundleSHA, &expiresAt, &bytesTotal)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "export not found")
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if status != "ready" {
		httperror.Write(w, http.StatusConflict, "export_not_ready", "export is not ready to download")
		return
	}
	if expiresAt == nil || !expiresAt.After(time.Now().UTC()) {
		httperror.Write(w, http.StatusGone, "export_expired", "export has expired")
		return
	}
	if objectKey == nil || strings.TrimSpace(*objectKey) == "" || bytesTotal <= 0 {
		httperror.Write(w, http.StatusConflict, "export_bundle_unavailable", "export bundle is unavailable")
		return
	}

	if !validExportObjectKey(*objectKey, tenant.ID, id) {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("export %s has a non-canonical private object key", id), r.Context())
		return
	}
	var (
		body       io.ReadCloser
		storedType string
		storedSize int64
		storedSHA  string
	)
	if r.Method == http.MethodHead {
		storedType, storedSize, storedSHA, err = d.Storage.Stat(r.Context(), *objectKey)
	} else {
		body, storedType, storedSize, storedSHA, err = d.Storage.Open(r.Context(), *objectKey)
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if body != nil {
		defer func() { _ = body.Close() }()
	}
	if storedType != "" && storedType != "application/zip" && storedType != "application/octet-stream" {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("export %s object has unexpected content type %q", id, storedType), r.Context())
		return
	}
	if storedSize != bytesTotal {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("export %s object size %d does not match recorded size %d", id, storedSize, bytesTotal),
			r.Context())
		return
	}
	if err := validateExportBundleDigest(*objectKey, tenant.ID, id, bundleSHA, storedSHA); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": "postwave-export-" + id + ".zip",
	}))
	w.Header().Set("Content-Length", strconv.FormatInt(bytesTotal, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.CopyN(w, body, bytesTotal); err != nil && d.Logger != nil {
		d.Logger.WarnContext(r.Context(), "export download stream failed", "export_id", id, "err", err)
	}
}

func validExportObjectKey(key, tenantID, exportID string) bool {
	if legacyExportObjectKey(key, tenantID, exportID) {
		return true
	}
	prefix := "exports/" + tenantID + "/" + exportID + "/"
	if !strings.HasPrefix(key, prefix) || !strings.HasSuffix(key, ".zip") {
		return false
	}
	token := strings.TrimSuffix(strings.TrimPrefix(key, prefix), ".zip")
	parsed, err := uuid.Parse(token)
	return err == nil && parsed.String() == token
}

func legacyExportObjectKey(key, tenantID, exportID string) bool {
	return key == "exports/"+tenantID+"/"+exportID+".zip"
}

func validateExportBundleDigest(
	objectKey, tenantID, exportID string,
	persistedSHA *string,
	storedSHA string,
) error {
	expectedSHA := strings.TrimSpace(derefStr(persistedSHA))
	if expectedSHA == "" {
		if legacyExportObjectKey(objectKey, tenantID, exportID) {
			return nil
		}
		return fmt.Errorf("export %s attempt object has no persisted SHA-256", exportID)
	}
	if !validSHA256Hex(expectedSHA) || storedSHA != expectedSHA {
		return fmt.Errorf("export %s object SHA-256 does not match its persisted digest", exportID)
	}
	return nil
}

func exportDownloadPath(tenantID, id, status string, objectKey, expiresAt *string) string {
	if status != "ready" || objectKey == nil || strings.TrimSpace(*objectKey) == "" || expiresAt == nil {
		return ""
	}
	if !validExportObjectKey(*objectKey, tenantID, id) {
		return ""
	}
	deadline, err := time.Parse(time.RFC3339Nano, *expiresAt)
	if err != nil || !deadline.After(time.Now().UTC()) {
		return ""
	}
	return "/api/v1/exports/" + id + "/download"
}

func decodePersistedResourceSelection(raw []byte) ([]string, error) {
	var resources []string
	if err := json.Unmarshal(raw, &resources); err != nil {
		return nil, err
	}
	if !validResourceSelection(resources) {
		return nil, fmt.Errorf("selection must contain unique supported resources")
	}
	return resources, nil
}

func isSupported(name string) bool {
	for _, r := range SupportedResources {
		if r == name {
			return true
		}
	}
	return false
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep imports referenced if file is built in isolation.
var (
	_ = errors.New
	_ = zip.NewWriter
	_ = fmt.Errorf
)

// canonicalExportState projects a tenant_exports status onto the shared
// operation vocabulary.
//
// Falls back to the raw value rather than guessing: `operation.Canonical`
// reports ok=false for anything unmapped, and inventing a state there would
// make a shared view either wait forever on finished work or report a healthy
// job as failed. An unmapped value passing through unchanged is visibly odd,
// which is the right failure for a projection.
func canonicalExportState(status string) string {
	if s, ok := operation.Canonical("tenant_exports", status); ok {
		return string(s)
	}
	return status
}
