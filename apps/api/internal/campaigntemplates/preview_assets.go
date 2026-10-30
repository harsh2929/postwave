// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultPreviewAssetMaxAttempts = 6
	maxPreviewAssetMaxAttempts     = 12
	maxPreviewProvenanceBytes      = 64 * 1024
	maxPreviewErrorBytes           = 2000
)

var (
	ErrNoPreviewAssets  = errors.New("campaign template previews: no jobs available")
	ErrPreviewLeaseLost = errors.New("campaign template previews: lease lost")
	ErrPreviewBlobMiss  = errors.New("campaign template previews: blob not found")
)

// PreviewAssetJob is a leased source image for one template rendering variant.
// BlobID may already be populated while a refresh runs; it is the retained
// last-known-good image and must not be cleared when the source disappears.
type PreviewAssetJob struct {
	ID               string
	TemplateID       string
	Variant          string
	SourceProvider   string
	SourceURL        string
	SourceProvenance json.RawMessage
	BlobID           string
	Attempts         int
	MaxAttempts      int
}

// PreviewBlob describes one sanitized, globally deduplicated hosted image.
type PreviewBlob struct {
	ID            string
	ContentSHA256 string
	StorageKey    string
	PublicURL     string
	MIME          string
	Width         int
	Height        int
	SizeBytes     int64
}

// PreviewAssetEnqueue schedules or refreshes a source without removing an
// already hosted fallback.
type PreviewAssetEnqueue struct {
	TemplateID       string
	Variant          string
	SourceProvider   string
	SourceURL        string
	SourceProvenance json.RawMessage
	MaxAttempts      int
}

// PreviewAssetEnqueuer is the narrow import dependency. Keeping the importer
// unaware of worker storage/lease methods makes job seeding easy to test and
// prevents request handlers from becoming an image proxy.
type PreviewAssetEnqueuer interface {
	Enqueue(context.Context, PreviewAssetEnqueue) (*PreviewAssetJob, error)
}

// PreviewAssetStore is the persistence surface consumed by the worker. The
// concrete repository below uses transaction-local worker scope and SKIP
// LOCKED; tests can exercise fetch/storage behaviour without a database.
type PreviewAssetStore interface {
	Claim(ctx context.Context, owner string, leaseTTL time.Duration, limit int) ([]PreviewAssetJob, error)
	FindBlob(ctx context.Context, contentSHA256 string) (*PreviewBlob, error)
	MarkReady(ctx context.Context, jobID, owner string, blob PreviewBlob) (*PreviewBlob, error)
	Renew(ctx context.Context, jobID, owner string, leaseTTL time.Duration) error
	MarkRetry(ctx context.Context, jobID, owner, detail string, retryAt time.Time) error
	MarkFailed(ctx context.Context, jobID, owner, detail string) error
	MarkSourceMissing(ctx context.Context, jobID, owner, detail string) error
}

// PreviewAssetRepo persists hosted preview jobs and shared image blobs.
type PreviewAssetRepo struct {
	Pool *db.Pool
}

// Enqueue inserts a source or resets its fetch state. It intentionally leaves
// blob_id and ready_at untouched on conflict so refreshes are non-destructive.
func (r *PreviewAssetRepo) Enqueue(ctx context.Context, in PreviewAssetEnqueue) (*PreviewAssetJob, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template previews: repository is not configured")
	}
	if strings.TrimSpace(in.TemplateID) == "" {
		return nil, errors.New("campaign template previews: template id is required")
	}
	if err := validatePreviewVariant(in.Variant); err != nil {
		return nil, err
	}
	if _, err := validatePreviewSourceStructure(in.SourceProvider, in.SourceURL); err != nil {
		return nil, err
	}
	provenance, err := normalizePreviewProvenance(in.SourceProvenance)
	if err != nil {
		return nil, err
	}
	maxAttempts := in.MaxAttempts
	if maxAttempts == 0 {
		maxAttempts = defaultPreviewAssetMaxAttempts
	}
	if maxAttempts < 1 || maxAttempts > maxPreviewAssetMaxAttempts {
		return nil, fmt.Errorf("campaign template previews: max attempts must be between 1 and %d", maxPreviewAssetMaxAttempts)
	}

	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var job PreviewAssetJob
	var raw []byte
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_preview_assets (
    template_id, variant, source_provider, source_url, source_provenance,
    status, attempts, max_attempts, next_attempt_at
) VALUES (
    $1::uuid, $2, $3, $4, $5::jsonb, 'queued', 0, $6, now()
)
ON CONFLICT (template_id, variant) DO UPDATE
   SET source_provider = EXCLUDED.source_provider,
       source_url = EXCLUDED.source_url,
       source_provenance = EXCLUDED.source_provenance,
       status = 'queued',
       attempts = 0,
       max_attempts = EXCLUDED.max_attempts,
       next_attempt_at = now(),
       last_attempt_at = NULL,
       last_error = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL
RETURNING id::text, template_id::text, variant, source_provider, source_url,
          source_provenance, COALESCE(blob_id::text, ''), attempts, max_attempts
`, in.TemplateID, in.Variant, in.SourceProvider, in.SourceURL, provenance, maxAttempts).Scan(
		&job.ID, &job.TemplateID, &job.Variant, &job.SourceProvider,
		&job.SourceURL, &raw, &job.BlobID, &job.Attempts, &job.MaxAttempts,
	)
	if err != nil {
		return nil, fmt.Errorf("campaign template previews: enqueue: %w", err)
	}
	job.SourceProvenance = append(json.RawMessage(nil), raw...)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &job, nil
}

// previewAssetClaimSQL is kept as a constant so the lease contract remains
// easy to review and pin in a focused test.
const previewAssetClaimSQL = `
WITH candidates AS (
    SELECT id
      FROM campaign_template_preview_assets
     WHERE (
           (
               status IN ('queued', 'retry')
               AND attempts < max_attempts
               AND next_attempt_at <= now()
           )
           OR (
               status = 'fetching'
               AND lease_expires_at <= now()
           )
       )
     ORDER BY next_attempt_at, created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $1
)
UPDATE campaign_template_preview_assets AS preview
   SET status = 'fetching',
       attempts = CASE
           -- A crashed worker already consumed this attempt. Recover the
           -- expired lease without exceeding max_attempts; the replacement
           -- worker can still succeed or mark the capped attempt failed.
           WHEN preview.status = 'fetching' THEN preview.attempts
           ELSE preview.attempts + 1
       END,
       last_attempt_at = now(),
       lease_owner = $2,
       lease_expires_at = now() + ($3::text)::interval
  FROM candidates
 WHERE preview.id = candidates.id
RETURNING preview.id::text, preview.template_id::text, preview.variant,
          preview.source_provider, preview.source_url, preview.source_provenance,
          COALESCE(preview.blob_id::text, ''), preview.attempts,
          preview.max_attempts`

// Claim leases a disjoint batch. Expired fetching rows are recoverable, while
// attempts at their cap stay terminal until explicitly re-enqueued.
func (r *PreviewAssetRepo) Claim(ctx context.Context, owner string, leaseTTL time.Duration, limit int) ([]PreviewAssetJob, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template previews: repository is not configured")
	}
	if strings.TrimSpace(owner) == "" {
		return nil, errors.New("campaign template previews: lease owner is required")
	}
	if leaseTTL <= 0 {
		return nil, errors.New("campaign template previews: lease duration must be positive")
	}
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}

	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, previewAssetClaimSQL, limit, owner, intervalMilliseconds(leaseTTL))
	if err != nil {
		return nil, fmt.Errorf("campaign template previews: claim: %w", err)
	}
	defer rows.Close()

	jobs := make([]PreviewAssetJob, 0, limit)
	for rows.Next() {
		var job PreviewAssetJob
		var raw []byte
		if err := rows.Scan(
			&job.ID, &job.TemplateID, &job.Variant, &job.SourceProvider,
			&job.SourceURL, &raw, &job.BlobID, &job.Attempts, &job.MaxAttempts,
		); err != nil {
			return nil, err
		}
		job.SourceProvenance = append(json.RawMessage(nil), raw...)
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(jobs) == 0 {
		return nil, ErrNoPreviewAssets
	}
	return jobs, nil
}

func (r *PreviewAssetRepo) FindBlob(ctx context.Context, contentSHA256 string) (*PreviewBlob, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template previews: repository is not configured")
	}
	if !validPreviewSHA256(contentSHA256) {
		return nil, errors.New("campaign template previews: invalid content hash")
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	blob, err := scanPreviewBlob(tx.QueryRow(ctx, `
SELECT id::text, content_sha256, storage_key, public_url, mime_type,
       width, height, size_bytes
  FROM campaign_template_preview_blobs
 WHERE content_sha256 = $1
`, contentSHA256))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreviewBlobMiss
	}
	if err != nil {
		return nil, fmt.Errorf("campaign template previews: find blob: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return blob, nil
}

// MarkReady inserts a shared blob if this hash is new, then attaches whichever
// row won the unique hash race. A lease loss can leave only a harmless
// content-addressed blob that a later retry will reuse.
func (r *PreviewAssetRepo) MarkReady(ctx context.Context, jobID, owner string, blob PreviewBlob) (*PreviewBlob, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template previews: repository is not configured")
	}
	if err := validatePreviewBlob(blob); err != nil {
		return nil, err
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_template_preview_blobs (
    content_sha256, storage_key, public_url, mime_type, width, height, size_bytes
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (content_sha256) DO NOTHING
`, blob.ContentSHA256, blob.StorageKey, blob.PublicURL, blob.MIME,
		blob.Width, blob.Height, blob.SizeBytes); err != nil {
		return nil, fmt.Errorf("campaign template previews: insert blob: %w", err)
	}

	canonical, err := scanPreviewBlob(tx.QueryRow(ctx, `
SELECT id::text, content_sha256, storage_key, public_url, mime_type,
       width, height, size_bytes
  FROM campaign_template_preview_blobs
 WHERE content_sha256 = $1
 FOR KEY SHARE
`, blob.ContentSHA256))
	if err != nil {
		return nil, fmt.Errorf("campaign template previews: select canonical blob: %w", err)
	}

	tag, err := tx.Exec(ctx, `
UPDATE campaign_template_preview_assets
   SET blob_id = $3::uuid,
       status = 'ready',
       next_attempt_at = now(),
       last_error = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       source_last_seen_at = now(),
       source_missing_at = NULL,
       ready_at = now()
 WHERE id = $1::uuid
   AND status = 'fetching'
   AND lease_owner = $2
`, jobID, owner, canonical.ID)
	if err != nil {
		return nil, fmt.Errorf("campaign template previews: attach blob: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrPreviewLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return canonical, nil
}

func (r *PreviewAssetRepo) MarkRetry(ctx context.Context, jobID, owner, detail string, retryAt time.Time) error {
	return r.mark(ctx, jobID, owner, `
UPDATE campaign_template_preview_assets
   SET status = 'retry',
       next_attempt_at = $3,
       last_error = $4,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id = $1::uuid
   AND status = 'fetching'
   AND lease_owner = $2
`, retryAt, safePreviewError(detail))
}

// Renew refreshes a claim immediately before a batch item begins network I/O.
// This prevents later items in a sequential batch from starting on an expired
// lease when earlier sources were slow.
func (r *PreviewAssetRepo) Renew(ctx context.Context, jobID, owner string, leaseTTL time.Duration) error {
	if leaseTTL <= 0 {
		return errors.New("campaign template previews: lease duration must be positive")
	}
	return r.mark(ctx, jobID, owner, `
UPDATE campaign_template_preview_assets
   SET lease_expires_at = now() + ($3::text)::interval
 WHERE id = $1::uuid
   AND status = 'fetching'
   AND lease_owner = $2
`, intervalMilliseconds(leaseTTL))
}

func (r *PreviewAssetRepo) MarkFailed(ctx context.Context, jobID, owner, detail string) error {
	return r.mark(ctx, jobID, owner, `
UPDATE campaign_template_preview_assets
   SET status = 'failed',
       last_error = $3,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id = $1::uuid
   AND status = 'fetching'
   AND lease_owner = $2
`, safePreviewError(detail))
}

// MarkSourceMissing changes only source state and lease fields. In particular,
// blob_id/ready_at are not assigned, preserving the hosted fallback.
func (r *PreviewAssetRepo) MarkSourceMissing(ctx context.Context, jobID, owner, detail string) error {
	return r.mark(ctx, jobID, owner, `
UPDATE campaign_template_preview_assets
   SET status = 'source_missing',
       last_error = $3,
       source_missing_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id = $1::uuid
   AND status = 'fetching'
   AND lease_owner = $2
`, safePreviewError(detail))
}

func (r *PreviewAssetRepo) mark(ctx context.Context, jobID, owner, statement string, args ...any) error {
	if r == nil || r.Pool == nil {
		return errors.New("campaign template previews: repository is not configured")
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queryArgs := []any{jobID, owner}
	queryArgs = append(queryArgs, args...)
	tag, err := tx.Exec(ctx, statement, queryArgs...)
	if err != nil {
		return fmt.Errorf("campaign template previews: update job: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrPreviewLeaseLost
	}
	return tx.Commit(ctx)
}

type previewBlobRow interface {
	Scan(dest ...any) error
}

func scanPreviewBlob(row previewBlobRow) (*PreviewBlob, error) {
	var blob PreviewBlob
	if err := row.Scan(
		&blob.ID, &blob.ContentSHA256, &blob.StorageKey, &blob.PublicURL,
		&blob.MIME, &blob.Width, &blob.Height, &blob.SizeBytes,
	); err != nil {
		return nil, err
	}
	return &blob, nil
}

func normalizePreviewProvenance(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "{}", nil
	}
	if len(raw) > maxPreviewProvenanceBytes {
		return "", fmt.Errorf("campaign template previews: provenance exceeds %d bytes", maxPreviewProvenanceBytes)
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return "", errors.New("campaign template previews: provenance must be a JSON object")
	}
	normalized, err := json.Marshal(object)
	if err != nil {
		return "", fmt.Errorf("campaign template previews: normalize provenance: %w", err)
	}
	return string(normalized), nil
}

func validatePreviewVariant(variant string) error {
	switch variant {
	case "desktop", "mobile", "card":
		return nil
	default:
		return errors.New("campaign template previews: variant must be desktop, mobile, or card")
	}
}

func validatePreviewBlob(blob PreviewBlob) error {
	if !validPreviewSHA256(blob.ContentSHA256) {
		return errors.New("campaign template previews: invalid content hash")
	}
	if strings.TrimSpace(blob.StorageKey) == "" || len(blob.StorageKey) > 1024 {
		return errors.New("campaign template previews: invalid storage key")
	}
	if strings.TrimSpace(blob.PublicURL) == "" || len(blob.PublicURL) > 4096 {
		return errors.New("campaign template previews: invalid public URL")
	}
	switch blob.MIME {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		return errors.New("campaign template previews: unsupported image MIME")
	}
	if blob.Width < 1 || blob.Width > 16384 || blob.Height < 1 || blob.Height > 16384 ||
		int64(blob.Width)*int64(blob.Height) > 40_000_000 {
		return errors.New("campaign template previews: invalid image dimensions")
	}
	if blob.SizeBytes < 1 || blob.SizeBytes > 10*1024*1024 {
		return errors.New("campaign template previews: invalid image byte size")
	}
	return nil
}

func validPreviewSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func intervalMilliseconds(duration time.Duration) string {
	return fmt.Sprintf("%d milliseconds", duration.Milliseconds())
}

func safePreviewError(detail string) string {
	detail = strings.TrimSpace(detail)
	if detail == "" {
		detail = "preview processing failed"
	}
	if len(detail) <= maxPreviewErrorBytes {
		return detail
	}
	return detail[:maxPreviewErrorBytes]
}
