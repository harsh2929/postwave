package handlers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	csvadapter "github.com/postwave/migrate/csv"
	"github.com/postwave/migrate/substack"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/uploadstore"
)

func configuredUploadStore() uploadstore.Store {
	root := os.Getenv("POSTWAVE_MIGRATION_UPLOAD_DIR")
	if root == "" {
		root = filepath.Join(os.TempDir(), "postwave-migration-uploads")
	}
	return uploadstore.Store{Root: root}
}

func migrationUploadsAllowed() bool {
	backend := strings.TrimSpace(os.Getenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND"))
	if backend == "efs" {
		return uploadstore.IsSharedMount(configuredUploadStore().Root)
	}
	if backend != "" && backend != "filesystem" {
		return false
	}
	return ephemeralMigrationUploadsAllowed()
}

// ValidateMigrationUploadStorage is a startup gate for explicitly configured
// storage. Production EFS cannot silently fall back to a task-local directory.
func ValidateMigrationUploadStorage() error {
	backend := strings.TrimSpace(os.Getenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND"))
	if backend == "" {
		return nil
	}
	if backend == "efs" && !uploadstore.IsSharedMount(configuredUploadStore().Root) {
		return fmt.Errorf("migration upload EFS mount is unavailable")
	}
	if !migrationUploadsAllowed() {
		return fmt.Errorf("migration upload storage backend is unavailable in this environment")
	}
	return configuredUploadStore().Validate()
}

func uploadRequest(w http.ResponseWriter, r *http.Request) (string, canonical.SourcePlatform, string, bool) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenant, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return "", source, "", false
	}
	if !sourceSupportsUploads(source) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("source %q does not support file uploads", source))
		return "", source, "", false
	}
	if !migrationUploadsAllowed() {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("durable migration upload storage is not configured"))
		return "", source, "", false
	}
	id, err := cleanUploadID(chi.URLParam(r, "upload_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return "", source, "", false
	}
	return tenant, source, id, true
}

func writeUploadError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, os.ErrNotExist):
		status = http.StatusNotFound
	case errors.Is(err, uploadstore.ErrDeleted):
		status = http.StatusGone
	case errors.Is(err, uploadstore.ErrConflict), errors.Is(err, uploadstore.ErrCorrupt):
		status = http.StatusConflict
	}
	writeErr(w, status, err)
}

func (h *Migration) UploadChunk(w http.ResponseWriter, r *http.Request) {
	tenant, source, id, ok := uploadRequest(w, r)
	if !ok {
		return
	}
	start, end, total, err := parseContentRange(r.Header.Get("Content-Range"))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if start < 0 || end < start || total <= 0 || end >= total {
		writeErr(w, 400, fmt.Errorf("invalid content range"))
		return
	}
	if total > maxMigrationUploadBytes {
		writeErr(w, 413, fmt.Errorf("upload exceeds %d bytes", maxMigrationUploadBytes))
		return
	}
	expected := end - start + 1
	if expected > maxMigrationUploadChunkBytes {
		writeErr(w, 413, fmt.Errorf("upload chunk exceeds %d bytes", maxMigrationUploadChunkBytes))
		return
	}
	if r.ContentLength >= 0 && r.ContentLength != expected {
		writeErr(w, 400, fmt.Errorf("content length does not match range length"))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, expected+1))
	if int64(len(data)) > expected {
		writeErr(w, 400, fmt.Errorf("chunk body exceeds Content-Range length %d", expected))
		return
	}
	if err != nil || int64(len(data)) != expected {
		writeErr(w, 400, fmt.Errorf("chunk body length does not match Content-Range"))
		return
	}
	filename := sanitizeUploadFilename(r.URL.Query().Get("filename"))
	if filename == "" {
		filename = "upload.csv"
	}
	m, err := configuredUploadStore().Put(r.Context(), tenant, string(source), id, filename, start, total, data)
	if err != nil {
		if errors.Is(err, uploadstore.ErrConflict) {
			writeJSON(w, 409, map[string]any{"error": err.Error(), "expected_offset": m.Received})
			return
		}
		writeUploadError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"upload_id": id, "received": m.Received, "total": m.Total})
}

func (h *Migration) UploadStatus(w http.ResponseWriter, r *http.Request) {
	tenant, source, id, ok := uploadRequest(w, r)
	if !ok {
		return
	}
	m, err := configuredUploadStore().Status(r.Context(), tenant, string(source), id)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"upload_id": id, "received": m.Received, "total": m.Total, "updated_at": m.UpdatedAt, "completed": m.Completed, "job_id": m.JobID})
}

func prepareStoredUpload(source canonical.SourcePlatform, m uploadstore.Metadata, path string) (map[string]string, error) {
	extra := map[string]string{"file_name": m.Filename, "upload_id": m.UploadID, "upload_sha256": m.SHA256}
	if sourceUsesCSVUpload(source) {
		extra["csv_path"] = path
	} else if source == canonical.SourceSubstack {
		prepared, err := substack.PrepareUpload(path, filepath.Dir(path), m.Filename)
		if err != nil {
			return nil, err
		}
		for k, v := range prepared {
			extra[k] = v
		}
	} else {
		return nil, fmt.Errorf("unsupported upload source")
	}
	return extra, nil
}

func (h *Migration) CompleteUpload(w http.ResponseWriter, r *http.Request) {
	tenant, source, id, ok := uploadRequest(w, r)
	if !ok {
		return
	}
	ctx := jobstore.WithTenantID(r.Context(), tenant)
	m, err := configuredUploadStore().Complete(ctx, tenant, string(source), id, func(m uploadstore.Metadata, path string) error {
		existing, err := h.store.Get(ctx, m.JobID)
		if err == nil {
			if existing.TenantID != tenant || existing.Source != source {
				return uploadstore.ErrConflict
			}
			boundID, _ := cursorString(existing.Cursor, "upload_id")
			boundHash, _ := cursorString(existing.Cursor, "upload_sha256")
			if boundID != id || boundHash != m.SHA256 {
				return uploadstore.ErrConflict
			}
			// A completed creation or a subsequently cleaned-up job must never
			// have its credentials/checkpoints replaced by an upload retry.
			if _, err := h.store.GetSessionInfo(ctx, tenant, m.JobID, time.Now()); err == nil {
				return nil
			} else if !errors.Is(err, jobstore.ErrNotFound) {
				return err
			}
			if existing.Status != canonical.MigAwaitingConfirmation {
				return fmt.Errorf("upload job exists without an active source session; start a new upload")
			}
		} else if !errors.Is(err, jobstore.ErrNotFound) {
			return err
		}
		extra, err := prepareStoredUpload(source, m, path)
		if err != nil {
			return fmt.Errorf("invalid source export: %w", err)
		}
		ad, err := adapter.Get(source)
		if err != nil {
			return err
		}
		sess, err := ad.Authenticate(ctx, adapter.Credentials{APIKey: "local-upload", AccountID: m.Filename, Extra: extra})
		if err != nil {
			return fmt.Errorf("invalid source export: %w", err)
		}
		if source == canonical.SourceCSV {
			sess.AccountID = m.Filename
		}
		if existing != nil {
			return h.saveSourceSession(ctx, m.JobID, tenant, sess, sessionExpiresAt(sess, time.Now()))
		}
		_, err = h.createJobWithID(ctx, m.JobID, tenant, source, sess)
		return err
	})
	if err != nil {
		if strings.HasPrefix(err.Error(), "invalid source export:") {
			writeErr(w, 400, err)
			return
		}
		writeUploadError(w, err)
		return
	}
	accountID := m.Filename
	if source == canonical.SourceSubstack {
		accountID = "substack-export:" + m.SHA256[:24]
	}
	writeJSON(w, 200, map[string]string{"job_id": m.JobID, "account_id": accountID})
}

// Refresh local file paths from shared storage before reading a stored session.
// Sessions keep mapping decisions; paths from an old process are never trusted.
func (h *Migration) restoreUploadSession(ctx context.Context, tenant, jobID string, sess adapter.Session) (adapter.Session, error) {
	id := sess.Extra["upload_id"]
	if id == "" {
		return sess, nil
	}
	if !migrationUploadsAllowed() {
		return adapter.Session{}, fmt.Errorf("migration upload storage is unavailable")
	}
	store := configuredUploadStore()
	m, err := store.Status(ctx, tenant, string(sess.Source), id)
	if err != nil {
		return adapter.Session{}, err
	}
	if !m.Completed || m.JobID != jobID || m.SHA256 != sess.Extra["upload_sha256"] {
		return adapter.Session{}, uploadstore.ErrConflict
	}
	dir, err := store.Dir(tenant, string(sess.Source), id)
	if err != nil {
		return adapter.Session{}, err
	}
	path := filepath.Join(dir, "payload")
	digest, err := uploadstore.Digest(path)
	if err != nil {
		return adapter.Session{}, err
	}
	if digest != m.SHA256 {
		return adapter.Session{}, uploadstore.ErrCorrupt
	}
	extra, err := prepareStoredUpload(sess.Source, m, path)
	if err != nil {
		return adapter.Session{}, err
	}
	copyExtra := make(map[string]string, len(sess.Extra)+len(extra))
	for k, v := range sess.Extra {
		copyExtra[k] = v
	}
	for k, v := range extra {
		copyExtra[k] = v
	}
	sess.Extra = copyExtra
	if sourceUsesCSVUpload(sess.Source) {
		mapping, err := csvadapter.DecodeMapping(sess.AccessToken)
		if err != nil {
			return adapter.Session{}, err
		}
		mapping.Path = path
		sess.AccessToken, err = csvadapter.EncodeMapping(mapping)
		if err != nil {
			return adapter.Session{}, err
		}
	}
	return sess, nil
}
