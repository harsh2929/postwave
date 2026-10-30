package handlers

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/uploadstore"
)

const rawUploadRetention = 30 * 24 * time.Hour

// SweepExpiredUploads preserves active executions and valid sessions. Failed
// cleanup is retried using the retained metadata tombstone, even after restart.
func (h *Migration) SweepExpiredUploads(ctx context.Context, now time.Time) (int, error) {
	if !migrationUploadsAllowed() {
		return 0, nil
	}
	deleted := 0
	store := configuredUploadStore()
	err := store.Walk(ctx, func(m uploadstore.Metadata) error {
		if m.UpdatedAt.IsZero() || now.Before(m.UpdatedAt.Add(rawUploadRetention)) {
			return nil
		}
		if m.JobID != "" {
			lease, err := h.acquireJobExecution(ctx, m.TenantID, m.JobID)
			if err != nil {
				return nil
			}
			defer lease.Release()
			scoped := jobstore.WithTenantID(ctx, m.TenantID)
			job, err := h.store.Get(scoped, m.JobID)
			if err != nil && !errors.Is(err, jobstore.ErrNotFound) {
				return err
			}
			if job != nil {
				switch job.Status {
				case canonical.MigDryRun, canonical.MigImporting, canonical.MigRollingBack:
					return nil
				}
				if _, err := h.store.GetSessionInfo(scoped, m.TenantID, m.JobID, now); err == nil {
					return nil
				} else if !errors.Is(err, jobstore.ErrNotFound) {
					return err
				}
			}
		}
		erased, err := store.DeleteBefore(ctx, m.TenantID, m.Source, m.UploadID, now.Add(-rawUploadRetention))
		if err != nil {
			return err
		}
		if erased {
			deleted++
		}
		return nil
	})
	return deleted, err
}

type expiredSessionSweeper interface {
	SweepExpiredSessions(context.Context, time.Time, int) (int, error)
}

func (h *Migration) StartSourceRetentionWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Hour
	}
	run := func() {
		if _, err := h.SweepExpiredUploads(ctx, time.Now()); err != nil {
			slog.Error("migration: upload retention failed", "err", err)
		}
		if sweeper, ok := h.store.(expiredSessionSweeper); ok {
			if _, err := sweeper.SweepExpiredSessions(ctx, time.Now(), 10000); err != nil {
				slog.Error("migration: source credential retention failed", "err", err)
			}
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}
