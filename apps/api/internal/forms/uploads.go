package forms

// File-upload support for forms (signup forms + multi-step surveys).
//
// Flow:
//
//   1. Browser POSTs {filename, mime, size} to
//      /api/public/forms/{slug}/upload-url. We validate against the
//      mime allowlist + the 25 MiB cap, generate a uuid + storage_key,
//      INSERT a form_file_uploads row with submission_id=NULL, and
//      return a presigned PUT URL the browser uploads to directly.
//
//   2. Browser PUTs the file bytes to that URL (S3 in prod, a stub
//      handler in dev — see local_upload_store.go).
//
//   3. The form value the browser sends in the final submit POST for
//      a file_upload field is the upload uuid. The submit handler
//      sees a `cf_<key>` whose value parses as a uuid that exists in
//      form_file_uploads, and calls Uploads.LinkToSubmission to flip
//      submission_id + linked_at on the row.
//
// We deliberately keep two implementations of UploadStore behind one
// interface so prod (S3) and dev/test (local /tmp) share the same
// presign contract. Production swaps via env (POSTWAVE_UPLOADS_BUCKET).
//
// NOTE: aws-sdk-go-v2 is NOT in go.mod at the time of writing (verified
// via `grep aws-sdk-go-v2 apps/api/go.mod`). We ship only the local
// store + the interface. To plug in S3, add the SDK to go.mod, write
// an S3UploadStore that implements UploadStore using s3.PresignClient,
// and wire it in main.go behind POSTWAVE_UPLOADS_BUCKET.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// MaxUploadBytes is the hard cap enforced both at presign-time (cheap
// rejection) and by the form_file_uploads CHECK constraint (defense in
// depth). 25 MiB.
const MaxUploadBytes int64 = 25 * 1024 * 1024 // 26214400

const (
	// DefaultTenantUploadQuotaBytes caps the sum of quarantined and clean
	// objects reserved by one tenant. It is deliberately conservative for a
	// public endpoint and can be raised per deployment after capacity review.
	DefaultTenantUploadQuotaBytes int64 = 1 << 30 // 1 GiB
	DefaultTenantPendingUploads         = 100
)

var (
	ErrUploadQuotaExceeded = errors.New("forms: tenant upload storage quota exceeded")
	ErrTooManyPending      = errors.New("forms: tenant has too many quarantined uploads")
)

// MimeAllowlist is the conservative set of mime types we accept for
// uploaded files. Tenants who need more should escalate; arbitrary
// uploads from public forms are an obvious malware vector.
//
// Using an exact-match allowlist (not a prefix scan) so that
// "image/svg+xml" — which can carry script payloads — stays rejected
// even though it nominally fits "image/*".
var MimeAllowlist = map[string]struct{}{
	"image/jpeg":      {},
	"image/png":       {},
	"image/webp":      {},
	"application/pdf": {},
	"text/plain":      {},
}

// NormalizeUploadMime returns the canonical mime token we store and pass to
// upload providers. It trims optional charset parameters and lowercases the
// token before allowlist checks.
func NormalizeUploadMime(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	return mime
}

// MimeAllowed returns true iff the mime type is in MimeAllowlist after
// trimming any "; charset=..." suffix.
func MimeAllowed(mime string) bool {
	mime = NormalizeUploadMime(mime)
	_, ok := MimeAllowlist[mime]
	return ok
}

// UploadStore is the narrow interface form uploads need. Implementations:
//   - S3UploadStore (production, requires aws-sdk-go-v2)
//   - LocalUploadStore (dev/test, writes to os.TempDir())
//
// Presign returns a PUT URL the browser uploads to. The second return value is
// retained for source compatibility but MUST remain empty: a read capability
// cannot be minted while the object is quarantined. A separate, clean-only
// download path may be added when attachments are surfaced to administrators.
// Delete is idempotent: implementations must treat an already-missing object
// as a successful cleanup so reclamation can be retried safely.
type UploadStore interface {
	Presign(ctx context.Context, key, mime string, size int64, ttl time.Duration) (putURL, getURL string, err error)
	Delete(ctx context.Context, key string) error
}

// PresignPutHeadersProvider is implemented by stores whose signed PUT request
// requires browser-supplied headers in addition to the URL. AWS S3 signs the
// normalized Content-Type and SSE-KMS headers; omitting any of them makes the
// otherwise-valid presigned request fail with SignatureDoesNotMatch.
type PresignPutHeadersProvider interface {
	PresignPutHeaders(mime string) map[string]string
}

// PresignResponse is the JSON returned from POST /api/public/forms/{slug}/upload-url.
type PresignResponse struct {
	UploadID   string            `json:"upload_id"`
	PutURL     string            `json:"put_url"`
	PutHeaders map[string]string `json:"put_headers,omitempty"`
	FieldValue string            `json:"field_value"`
	ExpiresAt  time.Time         `json:"expires_at"`
	ScanStatus string            `json:"scan_status"`
}

func presignPutHeaders(store UploadStore, mime string) map[string]string {
	provider, ok := store.(PresignPutHeadersProvider)
	if !ok {
		return nil
	}
	headers := provider.PresignPutHeaders(NormalizeUploadMime(mime))
	if len(headers) == 0 {
		return nil
	}
	// Return a defensive copy so a mutable backend map cannot race the JSON
	// encoder or leak changes across requests.
	copyHeaders := make(map[string]string, len(headers))
	for name, value := range headers {
		copyHeaders[name] = value
	}
	return copyHeaders
}

// PresignRequest is the JSON body of POST /api/public/forms/{slug}/upload-url.
type PresignRequest struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
}

const presignRequestMaxBodyBytes int64 = 16 << 10 // 16 KiB

// Uploads owns the presign + link handlers and is registered against
// the public router in main.go. It depends on the existing forms.Repo
// (for slug → tenant/form lookup) and a swappable UploadStore.
type Uploads struct {
	Pool   *db.Pool
	Repo   *Repo
	Store  UploadStore
	Logger *slog.Logger
	// ObjectReader + Scanner are required to release quarantined uploads.
	// Production startup refuses to run without both.
	ObjectReader UploadObjectReader
	Scanner      MalwareScanner

	TenantQuotaBytes        int64
	PendingLimit            int
	TrustForwardedIPHeaders bool

	// PresignTTL is how long the returned PUT URL stays valid; defaults
	// to 10 minutes when zero.
	PresignTTL time.Duration

	// rateLimiter is a process-local 10-req/min/IP bucket. Production
	// should front this with a real edge limiter; this is the fallback
	// so a cheap script can't spray a million presigns at us.
	rateLimiter ipRateLimiter
}

// Presign validates the request, INSERTs a form_file_uploads row, and
// returns the PUT URL the browser should upload to plus the field
// value (the upload id) the form will submit.
func (u *Uploads) Presign(
	ctx context.Context,
	tenantID, formID string,
	filename, mime string,
	size int64,
) (uploadID, putURL, fieldValue string, resultErr error) {
	if !MimeAllowed(mime) {
		return "", "", "", fmt.Errorf("forms: mime %q not allowed", mime)
	}
	mime = NormalizeUploadMime(mime)
	if size <= 0 {
		return "", "", "", errors.New("forms: size must be > 0")
	}
	if size > MaxUploadBytes {
		return "", "", "", fmt.Errorf("forms: size %d exceeds max %d", size, MaxUploadBytes)
	}
	if u.Store == nil {
		return "", "", "", errors.New("forms: no upload store configured")
	}

	uploadID, resultErr = newUploadID()
	if resultErr != nil {
		return "", "", "", resultErr
	}

	// Sanitize filename — we use it only as the trailing path component
	// of the storage key, but we still don't want path traversal or
	// control bytes in it.
	safeName := sanitizeFilename(filename)
	storageKey := quarantineStorageKey(tenantID, formID, uploadID, safeName)

	ttl := u.PresignTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	// Reserve quota before minting a provider URL. The tenant-scoped advisory
	// lock in insertRow makes concurrent public presigns one atomic budget.
	if err := u.insertRow(ctx, tenantID, formID, uploadID, storageKey, mime, size); err != nil {
		return "", "", "", err
	}
	// The validated byte count is part of the provider's signed PUT request.
	// A caller cannot obtain a 1-byte presign and then stream 25 MiB through it.
	put, _, resultErr := u.Store.Presign(ctx, storageKey, mime, size, ttl)
	if resultErr != nil {
		// Release a reservation when signing fails. A database cleanup failure is
		// intentionally joined: the orphan sweeper remains a final backstop.
		return "", "", "", errors.Join(fmt.Errorf("presign: %w", resultErr), u.deleteReservation(ctx, tenantID, uploadID))
	}
	return uploadID, put, uploadID, nil
}

// LinkToSubmission flips submission_id + linked_at on uploaded rows
// owned by `tenantID`. Called by the public submit handler once the
// submission row is durable. uploadIDs that don't resolve are silently
// skipped — they represent client-side noise (e.g. a uuid-shaped
// custom-field value that wasn't actually a file_upload).
func (u *Uploads) LinkToSubmission(ctx context.Context, tenantID, formID, submissionID string, uploadIDs []string) error {
	if tenantID == "" || formID == "" || submissionID == "" {
		return errors.New("forms: link requires tenant + form + submission id")
	}
	uploadIDs = filterUUIDs(uploadIDs)
	if len(uploadIDs) == 0 {
		return nil
	}
	tx, err := u.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	// Only update rows that are still orphans (submission_id IS NULL) so
	// re-submits don't re-attach the same upload to a new submission.
	if _, err := tx.Exec(ctx, `
UPDATE form_file_uploads
   SET submission_id = $1::uuid, linked_at = now()
 WHERE tenant_id = $2::uuid
	AND form_id = $3::uuid
   AND submission_id IS NULL
   AND cleanup_claimed_at IS NULL
	AND scan_status IN ('pending', 'quarantined')
	AND id::text = ANY($4)`, submissionID, tenantID, formID, uploadIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// HandlePresignRequest serves POST /api/public/forms/{slug}/upload-url.
// Public route, no auth, but the slug must resolve to a published form.
func (u *Uploads) HandlePresignRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errEnv("method", "POST required"))
		return
	}
	ip := clientIP(r, u.TrustForwardedIPHeaders)
	if !u.rateLimiter.allow(ip) {
		writeFormUploadIPRateLimit(w)
		return
	}

	slug := chi.URLParam(r, "slug")
	form, formErr := u.Repo.ByPublicSlug(r.Context(), slug)
	if formErr != nil {
		if errors.Is(formErr, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such form"))
			return
		}
		writeJSON(w, http.StatusInternalServerError, errEnv("lookup_failed", "form is temporarily unavailable"))
		return
	}

	var in PresignRequest
	if err := httpbody.DecodeJSON(w, r, presignRequestMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes from the IsValidationCode
		// allowlist (bad_json, payload_too_large), so echoing err.Error()
		// here is safe.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Filename = strings.TrimSpace(in.Filename)
	in.Mime = NormalizeUploadMime(in.Mime)
	if in.Filename == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_filename", "filename required"))
		return
	}
	if !MimeAllowed(in.Mime) {
		writeJSON(w, http.StatusUnsupportedMediaType, errEnv("bad_mime",
			fmt.Sprintf("mime %q not allowed", in.Mime)))
		return
	}
	if in.Size <= 0 || in.Size > MaxUploadBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("bad_size",
			fmt.Sprintf("size must be 1..%d bytes", MaxUploadBytes)))
		return
	}

	uploadID, putURL, fieldValue, formErr := u.Presign(
		r.Context(), form.TenantID, form.ID, in.Filename, in.Mime, in.Size,
	)
	if formErr != nil {
		switch {
		case errors.Is(formErr, ErrUploadQuotaExceeded):
			writeFormUploadQuotaDenial(w, "tenant_upload_quota_exceeded", "workspace upload storage quota reached")
		case errors.Is(formErr, ErrTooManyPending):
			writeFormUploadQuotaDenial(w, "too_many_quarantined_uploads", "too many uploads are awaiting completion or scanning")
		default:
			writeJSON(w, http.StatusServiceUnavailable, errEnv("presign_failed", "upload is temporarily unavailable"))
		}
		return
	}

	ttl := u.PresignTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	writeJSON(w, http.StatusOK, PresignResponse{
		UploadID:   uploadID,
		PutURL:     putURL,
		PutHeaders: presignPutHeaders(u.Store, in.Mime),
		FieldValue: fieldValue,
		ExpiresAt:  time.Now().UTC().Add(ttl),
		ScanStatus: "quarantined",
	})
}

// writeFormUploadIPRateLimit is a public anti-abuse/protocol boundary rather
// than a workspace product entitlement. It stays deliberately opaque and is
// registered as such by the entitlement-denial gate.
func writeFormUploadIPRateLimit(w http.ResponseWriter) {
	writeJSON(w, http.StatusTooManyRequests, errEnv("rate_limited", "too many uploads from this IP"))
}

func writeFormUploadQuotaDenial(w http.ResponseWriter, code, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject:  "form_upload",
		Reason:   entitlement.ReasonQuota,
		Code:     code,
		Message:  message,
		Resource: "form_upload_storage",
	})
}

// insertRow writes the form_file_uploads row inside a tx that binds
// app.tenant_id so RLS accepts it.
func (u *Uploads) insertRow(
	ctx context.Context,
	tenantID, formID, uploadID, storageKey, mime string,
	size int64,
) error {
	if u == nil || u.Pool == nil {
		return errors.New("forms: upload reservation requires database pool")
	}
	tx, err := u.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	// Serialize quota reservations per tenant across every gateway replica.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('form-upload-quota:' || $1, 0))`, tenantID); err != nil {
		return err
	}
	quota := u.TenantQuotaBytes
	if quota <= 0 {
		quota = DefaultTenantUploadQuotaBytes
	}
	pendingLimit := u.PendingLimit
	if pendingLimit <= 0 {
		pendingLimit = DefaultTenantPendingUploads
	}
	var reserved int64
	var pending int
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sum(size_bytes) FILTER (WHERE object_deleted_at IS NULL), 0)::bigint,
       count(*) FILTER (WHERE scan_status IN ('pending','quarantined'))::int
  FROM form_file_uploads
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&reserved, &pending); err != nil {
		return err
	}
	if pending >= pendingLimit {
		return ErrTooManyPending
	}
	if !uploadQuotaAllows(reserved, size, quota) {
		return ErrUploadQuotaExceeded
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO form_file_uploads (id, tenant_id, form_id, storage_key, mime_type, size_bytes, scan_status)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'quarantined')`,
		uploadID, tenantID, formID, storageKey, mime, size); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uploadQuotaAllows(reserved, requested, quota int64) bool {
	return quota > 0 && requested > 0 && requested <= quota && reserved >= 0 && reserved <= quota-requested
}

func quarantineStorageKey(tenantID, formID, uploadID, filename string) string {
	return fmt.Sprintf("quarantine/tenant/%s/form/%s/%s/%s", tenantID, formID, uploadID, filename)
}

func (u *Uploads) deleteReservation(ctx context.Context, tenantID, uploadID string) error {
	if u == nil || u.Pool == nil {
		return errors.New("forms: upload reservation cleanup requires database pool")
	}
	tx, err := db.WithTenant(ctx, u.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM form_file_uploads
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND submission_id IS NULL AND scan_status = 'quarantined'`, tenantID, uploadID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// newUploadID returns a UUIDv4-shaped lowercase hex string. We intentionally
// don't pull in google/uuid since the rest of the package gets by without it.
func newUploadID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	// Set version (4) and variant (RFC 4122) bits.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexs := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexs[0:8], hexs[8:12], hexs[12:16], hexs[16:20], hexs[20:32]), nil
}

// filterUUIDs returns only the strings that look like UUIDs. The submit
// handler passes every cf_<key> value through; we don't want to issue
// UPDATE WHERE id IN (...) with arbitrary text.
func filterUUIDs(ss []string) []string {
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if isUUIDLike(s) {
			out = append(out, s)
		}
	}
	return out
}

// isUUIDLike returns true for the canonical 8-4-4-4-12 hex form. Cheap
// pre-filter; the database CAST validates on the actual UPDATE.
func isUUIDLike(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !ok {
				return false
			}
		}
	}
	return true
}

// sanitizeFilename strips path components and any control / unsafe bytes.
// Returns "file" if the result would be empty.
func sanitizeFilename(name string) string {
	name = filepath.Base(name)
	if name == "." || name == "/" || name == "\\" {
		return "file"
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	for strings.Contains(out, "..") {
		out = strings.ReplaceAll(out, "..", ".")
	}
	out = strings.TrimLeft(out, ".")
	if out == "" {
		return "file"
	}
	if len(out) > 128 {
		out = out[:128]
	}
	return out
}

// ipRateLimiter is a tiny per-IP token bucket: 10 events / minute. We
// use a process-local map; for multi-replica setups, replace with a
// Redis-backed limiter at the edge (Cloudflare / nginx). Worth ~$0
// to operate and stops the obvious "loop on presign" attack.
type ipRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*ipBucket
}

type ipBucket struct {
	resetAt time.Time
	count   int
}

func (l *ipRateLimiter) allow(ip string) bool {
	if ip == "" {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[string]*ipBucket{}
	}
	now := time.Now()
	b := l.buckets[ip]
	if b == nil || now.After(b.resetAt) {
		l.buckets[ip] = &ipBucket{resetAt: now.Add(time.Minute), count: 1}
		return true
	}
	if b.count >= 10 {
		return false
	}
	b.count++
	return true
}
