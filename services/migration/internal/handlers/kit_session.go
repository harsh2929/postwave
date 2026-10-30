package handlers

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/convertkit"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func kitSessionNeedsRefresh(sess adapter.Session, now time.Time) bool {
	return sess.Source == canonical.SourceConvertKit && sess.RefreshToken != "" && (sess.ExpiresAt.IsZero() || !sess.ExpiresAt.After(now.Add(2*time.Minute)))
}

func (h *Migration) loadAndRefreshSession(ctx context.Context, tenantID, jobID string) (adapter.Session, error) {
	ctx = jobstore.WithTenantID(ctx, tenantID)
	sess, err := h.store.GetSession(ctx, tenantID, jobID, time.Now())
	if err != nil || !kitSessionNeedsRefresh(sess, time.Now()) {
		return sess, err
	}
	lease, err := orchestrator.AcquireMigrationSessionRefreshLease(ctx, h.db, tenantID, jobID)
	if err != nil {
		return adapter.Session{}, err
	}
	defer func() { _ = lease.Release() }()
	// Another replica may have rotated it between our initial read and lock.
	sess, err = h.store.GetSession(ctx, tenantID, jobID, time.Now())
	if err != nil || !kitSessionNeedsRefresh(sess, time.Now()) {
		return sess, err
	}
	job, err := h.store.Get(ctx, jobID)
	if err != nil {
		return adapter.Session{}, err
	}
	if err := requireBoundSourceAccount(job, sess); err != nil {
		return adapter.Session{}, err
	}
	refresh := h.kitSessionRefresher
	if refresh == nil {
		refresh = convertkit.New().RefreshSession
	}
	updated, err := refresh(ctx, sess)
	if err != nil {
		return adapter.Session{}, err
	}
	if err := requireBoundSourceAccount(job, updated); err != nil {
		return adapter.Session{}, err
	}
	if updated.Source != canonical.SourceConvertKit || updated.AccessToken == "" || updated.RefreshToken == "" || !updated.ExpiresAt.After(time.Now()) {
		return adapter.Session{}, fmt.Errorf("Kit refresh returned an incomplete session; reconnect source")
	}
	// Never hand new tokens to a worker until both have been persisted. If
	// this write fails, the caller must reconnect rather than replay a spent
	// refresh token and pretend the job can safely continue.
	if err := h.store.SaveSession(ctx, jobID, tenantID, updated, sessionExpiresAt(updated, time.Now())); err != nil {
		return adapter.Session{}, fmt.Errorf("Kit credential rotation could not be saved; reconnect source: %w", err)
	}
	return updated, nil
}

func (h *Migration) saveSourceSession(ctx context.Context, jobID, tenantID string, sess adapter.Session, expiresAt time.Time) error {
	if sess.Source != canonical.SourceConvertKit {
		return h.store.SaveSession(ctx, jobID, tenantID, sess, expiresAt)
	}
	lease, err := orchestrator.AcquireMigrationSessionRefreshLease(ctx, h.db, tenantID, jobID)
	if err != nil {
		return err
	}
	defer func() { _ = lease.Release() }()
	return h.store.SaveSession(ctx, jobID, tenantID, sess, expiresAt)
}

// configureSourceSessionResolver keeps every page and dependent resource read
// current, including jobs that outlive a 48-hour Kit access token. The caller
// holds the job execution lease; refresh itself takes the durable session lock.
func (h *Migration) configureSourceSessionResolver(ad adapter.Adapter, job *canonical.MigrationJob) {
	kit, ok := ad.(*convertkit.Adapter)
	if !ok || job == nil {
		return
	}
	kit.ResolveSession = func(ctx context.Context) (adapter.Session, error) {
		sess, err := h.loadAndRefreshSession(ctx, job.TenantID, job.ID)
		if err != nil {
			return adapter.Session{}, err
		}
		if err := requireBoundSourceAccount(job, sess); err != nil {
			return adapter.Session{}, err
		}
		return sess, nil
	}
}
