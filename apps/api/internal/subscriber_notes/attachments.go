// SPDX-License-Identifier: AGPL-3.0-only
//
// attachments.go — SUB-097: file attachments on subscriber notes.
//
// New attachment creation is deliberately unavailable. The repository has no
// upload-session service that binds an object to the tenant and note, verifies
// its bytes, and releases it after scanning. Accepting a client-supplied key
// would therefore let callers register arbitrary unverified metadata. The POST
// route remains mounted only to return a stable fail-closed capability result.
//
// Existing authorized rows remain readable through PresignGet and removable.
//
// Storage is the broad uploads.Store surface (Put/Get/Delete/PresignGet/
// List). It is optional on Deps — when nil (e.g. an env without an object
// store configured) the attachment endpoints answer 503 rather than
// panicking, and the rest of the notes API keeps working.

package subscriber_notes

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// presignTTL is the download-link lifetime handed to the browser. Short
// enough that a leaked link expires before it can be widely shared, long
// enough for a normal "click to download" round-trip.
const presignTTL = 15 * time.Minute

const (
	attachmentUploadUnavailableCode    = "note_attachment_upload_unavailable"
	attachmentUploadUnavailableMessage = "Secure note attachment uploads are not available."
)

// Attachment is the API projection of one subscriber_note_attachments row.
// DownloadURL is populated lazily on List with a presigned GET.
type Attachment struct {
	ID               string    `json:"id"`
	NoteID           string    `json:"note_id"`
	FileKey          string    `json:"file_key"`
	Filename         string    `json:"filename"`
	ContentType      string    `json:"content_type"`
	SizeBytes        int64     `json:"size_bytes"`
	UploadedByUserID string    `json:"uploaded_by_user_id,omitempty"`
	UploadedByEmail  string    `json:"uploaded_by_email,omitempty"`
	UploadedAt       time.Time `json:"uploaded_at"`
	DownloadURL      string    `json:"download_url,omitempty"`
}

// AddAttachment POST /api/v1/subscribers/{id}/notes/{note}/attachments.
// Fails closed until a verified upload-session/quarantine service exists.
// Keeping the route stable lets older clients receive an explicit capability
// envelope instead of mistaking a 404 or transport failure for a retryable
// registration error.
func (d *Deps) AddAttachment(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	writeErr(
		w,
		http.StatusServiceUnavailable,
		attachmentUploadUnavailableCode,
		attachmentUploadUnavailableMessage,
	)
}

// DeleteAttachment DELETE
// /api/v1/subscribers/{id}/notes/{note}/attachments/{file_key}.
// Removes the metadata row and best-effort deletes the underlying object.
func (d *Deps) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Store == nil {
		writeErr(w, http.StatusServiceUnavailable, "uploads_unavailable", "object store not configured")
		return
	}
	subID := chi.URLParam(r, "id")
	noteID := chi.URLParam(r, "note")
	// chi already URL-decodes the path param; {file_key:.+} captures slashes.
	fileKey := chi.URLParam(r, "file_key")
	if strings.TrimSpace(fileKey) == "" {
		writeErr(w, http.StatusBadRequest, "missing_file_key", "")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	tag, err := tx.Exec(r.Context(), `
DELETE FROM subscriber_note_attachments
 WHERE tenant_id = $1::uuid
   AND note_id = $2::uuid
   AND subscriber_id = $3::uuid
   AND file_key = $4`, t.ID, noteID, subID, fileKey)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Best-effort object delete AFTER the row commit. uploads.Store.Delete
	// is idempotent (no error on a missing key), so a partial failure here
	// leaves an orphan object but never a dangling row, and a retry is safe.
	if err := d.Store.Delete(r.Context(), t.ID, fileKey); err != nil && d.Logger != nil {
		d.Logger.Warn("subscriber_notes: attachment object delete failed",
			"tenant_id", t.ID, "file_key", fileKey, "err", err.Error())
	}
	w.WriteHeader(http.StatusNoContent)
}

// loadAttachments returns the attachments for a set of note ids, keyed by
// note id, each carrying a freshly-presigned download URL. Used by List to
// inline attachments into the notes response. A presign failure on one
// attachment is non-fatal — the row is still returned, just without a URL.
func (d *Deps) loadAttachments(r *http.Request, tenantID string, noteIDs []string) map[string][]Attachment {
	out := map[string][]Attachment{}
	if d.Store == nil || len(noteIDs) == 0 {
		return out
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return out
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, note_id::text, file_key, filename, content_type,
       size_bytes, COALESCE(uploaded_by_user_id::text, ''),
       COALESCE(uploaded_by_email::text, ''), uploaded_at
  FROM subscriber_note_attachments
 WHERE tenant_id = $1::uuid AND note_id = ANY($2::uuid[])
 ORDER BY uploaded_at DESC`, tenantID, noteIDs)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.ID, &a.NoteID, &a.FileKey, &a.Filename,
			&a.ContentType, &a.SizeBytes, &a.UploadedByUserID,
			&a.UploadedByEmail, &a.UploadedAt); err != nil {
			continue
		}
		if url, perr := d.Store.PresignGet(r.Context(), tenantID, a.FileKey, presignTTL); perr == nil {
			a.DownloadURL = url
		}
		out[a.NoteID] = append(out[a.NoteID], a)
	}
	return out
}
