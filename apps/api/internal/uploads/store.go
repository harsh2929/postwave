// Package uploads is the canonical interface for tenant-scoped file
// storage (signup-form attachments, exported reports, asset uploads…).
//
// Two implementations live here:
//   - S3UploadStore — production. Uses aws-sdk-go-v2 with SSE-KMS so
//     uploaded objects are KMS-encrypted at rest, and presigned URLs
//     for the browser-facing GET path.
//   - MemoryStore — tests / dev fallback when POSTWAVE_UPLOADS_BUCKET
//     is unset and the platform doesn't want to write to local disk.
//
// All keys are namespaced under tenants/{tenantID}/ to enforce isolation
// at the storage layer (in addition to RLS at the DB layer). The store
// rejects reads/writes to keys outside that prefix unless AdminBypass is
// set on the call (used for system-level uploads such as backups).
//
// The narrow forms.UploadStore interface (Presign-only) is preserved
// elsewhere; this package's Store is the broader surface used by anything
// that genuinely needs Get / Put / Delete.
package uploads

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"
)

// Store is the production-shaped surface for object storage. Methods take
// a tenantID; keys are derived as tenants/{tenantID}/{rest}.
type Store interface {
	// Put writes body under tenants/{tenantID}/{rest}. Returns the
	// canonical (final) storage key.
	Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (key string, err error)

	// Get reads the object under tenants/{tenantID}/{rest}. Caller
	// closes the returned ReadCloser.
	Get(ctx context.Context, tenantID, rest string) (body io.ReadCloser, contentType string, err error)

	// Delete removes the object. No-op (no error) if the key does not
	// exist — matches S3 DeleteObject semantics so retried rollbacks
	// don't fail.
	Delete(ctx context.Context, tenantID, rest string) error

	// PresignGet returns a time-limited URL the caller can hand to a
	// browser for direct download. ttl=0 → DefaultPresignTTL.
	PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (url string, err error)

	// List enumerates objects under tenants/{tenantID}/{prefix}, lex-sorted,
	// strictly after `cursor` (tenant-relative key). Returns tenant-relative
	// keys so the caller can pass them straight to Get/Delete. Capped at
	// max(limit, 1) entries, hard ceiling 1000 to match S3 ListObjectsV2.
	// nextCursor is the last key returned (empty when the result is empty).
	// Callers persist nextCursor and use it on the next call for incremental
	// scans; semantics are lex-after, NOT a server token, so the same key is
	// never delivered twice as long as the cursor is rotated forward.
	List(ctx context.Context, tenantID, prefix, cursor string, limit int) (keys []string, nextCursor string, err error)
}

// DefaultPresignTTL is what every store hands out when the caller passes
// 0 / negative. One hour is the standard "user clicks a download link"
// window without being so long that link sharing is dangerous.
const DefaultPresignTTL = 1 * time.Hour

// ErrInvalidKey is returned when a caller asks for a key outside its
// tenant prefix and the store isn't in admin-bypass mode.
var ErrInvalidKey = errors.New("uploads: key outside tenant prefix")

// ErrNotFound is returned by Get when the object does not exist. Delete
// remains idempotent and does NOT return ErrNotFound.
var ErrNotFound = errors.New("uploads: object not found")

// joinKey concatenates tenants/{tenantID}/{rest} with cheap path-traversal
// rejection. Production-grade defence-in-depth; the IAM policy on the
// underlying bucket should also forbid cross-tenant access.
func joinKey(tenantID, rest string) (string, error) {
	if tenantID == "" {
		return "", ErrInvalidKey
	}
	if strings.Contains(rest, "..") || strings.HasPrefix(rest, "/") {
		return "", ErrInvalidKey
	}
	rest = strings.TrimLeft(rest, "/")
	return "tenants/" + tenantID + "/" + rest, nil
}

// validateAdminKey is used by callers that bypass tenant scoping (e.g.
// system backups). Only allows a small allowlist of system-prefixes so
// admin-mode can't be flipped on accidentally to read tenant data.
func validateAdminKey(key string) error {
	if !strings.HasPrefix(key, "system/") {
		return ErrInvalidKey
	}
	if strings.Contains(key, "..") {
		return ErrInvalidKey
	}
	return nil
}
