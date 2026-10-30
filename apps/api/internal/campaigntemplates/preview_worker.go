// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"time"

	"github.com/postwave/postwave/apps/api/internal/assets"
)

const (
	defaultPreviewWorkerBatch = 20
	maxPreviewWorkerBatch     = 100
	defaultPreviewLeaseTTL    = 2 * time.Minute
	defaultPreviewPollDelay   = 1 * time.Second
	initialPreviewRetryDelay  = 30 * time.Second
	maxPreviewRetryDelay      = 6 * time.Hour
)

// PreviewAssetWorker fetches only pre-enqueued provider URLs. It is not an
// HTTP proxy and exposes no request-time pixel path: callers run bounded queue
// ticks, and clients consume only already hosted public URLs.
type PreviewAssetWorker struct {
	Store        PreviewAssetStore
	Storage      assets.Storage
	Fetcher      *PreviewFetcher
	Owner        string
	BatchSize    int
	LeaseTTL     time.Duration
	Logger       *slog.Logger
	PollInterval time.Duration
	Now          func() time.Time
}

// Run continuously drains the durable queue until shutdown. A short follow-up
// delay keeps bulk imports moving; an empty queue backs off to the normal poll
// interval.
func (w *PreviewAssetWorker) Run(ctx context.Context) {
	interval := w.PollInterval
	if interval <= 0 {
		interval = defaultPreviewPollDelay
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		processed, err := w.RunOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			w.logger().Error("campaign template preview worker", "error", err)
		}
		delay := interval
		if processed > 0 {
			delay = 25 * time.Millisecond
		}
		timer.Reset(delay)
	}
}

// RunOnce claims and processes one bounded batch. Independent job failures are
// persisted and joined so one bad source cannot prevent the rest from moving.
func (w *PreviewAssetWorker) RunOnce(ctx context.Context) (int, error) {
	if err := w.validate(); err != nil {
		return 0, err
	}
	batch := w.BatchSize
	if batch <= 0 {
		batch = defaultPreviewWorkerBatch
	}
	if batch > maxPreviewWorkerBatch {
		batch = maxPreviewWorkerBatch
	}
	leaseTTL := w.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = defaultPreviewLeaseTTL
	}
	jobs, err := w.Store.Claim(ctx, w.Owner, leaseTTL, batch)
	if errors.Is(err, ErrNoPreviewAssets) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var jobErrors []error
	for _, job := range jobs {
		if err := w.Store.Renew(ctx, job.ID, w.Owner, leaseTTL); err != nil {
			jobErrors = append(jobErrors, fmt.Errorf("preview job %s: renew lease: %w", job.ID, err))
			continue
		}
		if err := w.process(ctx, job); err != nil {
			jobErrors = append(jobErrors, fmt.Errorf("preview job %s: %w", job.ID, err))
		}
	}
	return len(jobs), errors.Join(jobErrors...)
}

func (w *PreviewAssetWorker) process(ctx context.Context, job PreviewAssetJob) error {
	fetched, err := w.Fetcher.Fetch(ctx, job.SourceProvider, job.SourceURL)
	if err != nil {
		switch {
		case errors.Is(err, ErrPreviewSourceMissing):
			return w.Store.MarkSourceMissing(ctx, job.ID, w.Owner, err.Error())
		case errors.Is(err, ErrPreviewWrongMIME),
			errors.Is(err, ErrPreviewOversize),
			errors.Is(err, ErrPreviewInvalidImage),
			errors.Is(err, ErrPreviewSourceRejected):
			return w.Store.MarkFailed(ctx, job.ID, w.Owner, err.Error())
		default:
			return w.retryOrFail(ctx, job, err)
		}
	}

	existing, err := w.Store.FindBlob(ctx, fetched.ContentSHA256)
	switch {
	case err == nil:
		_, err = w.Store.MarkReady(ctx, job.ID, w.Owner, *existing)
		return err
	case !errors.Is(err, ErrPreviewBlobMiss):
		return w.retryOrFail(ctx, job, fmt.Errorf("dedupe lookup: %w", err))
	}

	storageKey, err := previewStorageKey(fetched.ContentSHA256, fetched.MIME)
	if err != nil {
		return w.Store.MarkFailed(ctx, job.ID, w.Owner, err.Error())
	}
	publicURL, err := w.Storage.Put(ctx, storageKey, fetched.MIME, fetched.Body)
	if err != nil {
		return w.retryOrFail(ctx, job, fmt.Errorf("host preview: %w", err))
	}
	_, err = w.Store.MarkReady(ctx, job.ID, w.Owner, PreviewBlob{
		ContentSHA256: fetched.ContentSHA256,
		StorageKey:    storageKey,
		PublicURL:     publicURL,
		MIME:          fetched.MIME,
		Width:         fetched.Width,
		Height:        fetched.Height,
		SizeBytes:     int64(len(fetched.Body)),
	})
	return err
}

func (w *PreviewAssetWorker) retryOrFail(ctx context.Context, job PreviewAssetJob, cause error) error {
	if job.MaxAttempts <= 0 {
		job.MaxAttempts = defaultPreviewAssetMaxAttempts
	}
	if job.Attempts >= job.MaxAttempts {
		return w.Store.MarkFailed(ctx, job.ID, w.Owner, cause.Error())
	}
	retryAt := w.now().Add(previewRetryBackoff(job.Attempts))
	return w.Store.MarkRetry(ctx, job.ID, w.Owner, cause.Error(), retryAt)
}

func (w *PreviewAssetWorker) validate() error {
	if w == nil || w.Store == nil || w.Storage == nil || w.Fetcher == nil {
		return errors.New("campaign template previews: worker dependencies are incomplete")
	}
	if w.Owner == "" {
		return errors.New("campaign template previews: worker owner is required")
	}
	return nil
}

func (w *PreviewAssetWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *PreviewAssetWorker) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func previewRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := initialPreviewRetryDelay
	for step := 1; step < attempt && delay < maxPreviewRetryDelay; step++ {
		delay *= 2
		if delay >= maxPreviewRetryDelay {
			return maxPreviewRetryDelay
		}
	}
	return delay
}

func previewStorageKey(contentSHA256, mime string) (string, error) {
	if !validPreviewSHA256(contentSHA256) {
		return "", errors.New("campaign template previews: invalid content hash")
	}
	var extension string
	switch mime {
	case "image/png":
		extension = ".png"
	case "image/jpeg":
		extension = ".jpg"
	case "image/gif":
		extension = ".gif"
	case "image/webp":
		extension = ".webp"
	default:
		return "", errors.New("campaign template previews: unsupported image MIME")
	}
	return path.Join(
		"campaign-template-previews",
		"sha256",
		contentSHA256[:2],
		contentSHA256+extension,
	), nil
}
