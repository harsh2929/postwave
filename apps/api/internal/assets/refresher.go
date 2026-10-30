// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"log/slog"
	"time"
)

// TenantLister returns the list of tenant ids currently active. The
// refresher takes this as an interface so we don't depend on the
// tenants package directly — the bootstrap site supplies a tiny adapter.
type TenantLister interface {
	ActiveTenantIDs(ctx context.Context) ([]string, error)
}

// Refresher periodically rebuilds references_count + last_used_at for
// every asset of every active tenant. Lightweight — one pass per tenant
// per tick, bounded by tenant size.
//
// Run blocks until ctx is cancelled. Safe to start as a background
// goroutine in the server bootstrap; stops cleanly on ctx.Done().
type Refresher struct {
	Repo     *Repo
	Tenants  TenantLister
	Interval time.Duration // default 5 minutes
	Logger   *slog.Logger
}

// Run blocks until ctx is cancelled, ticking every Interval.
func (rf *Refresher) Run(ctx context.Context) {
	if rf.Interval == 0 {
		rf.Interval = 5 * time.Minute
	}
	ticker := time.NewTicker(rf.Interval)
	defer ticker.Stop()
	rf.tick(ctx) // immediate first run so chips populate without a 5-min wait
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rf.tick(ctx)
		}
	}
}

func (rf *Refresher) tick(ctx context.Context) {
	if rf.Repo == nil || rf.Tenants == nil {
		return
	}
	ids, err := rf.Tenants.ActiveTenantIDs(ctx)
	if err != nil {
		if rf.Logger != nil {
			rf.Logger.Warn("assets refresher: list tenants", "err", err)
		}
		return
	}
	for _, tid := range ids {
		if ctx.Err() != nil {
			return
		}
		if err := rf.Repo.RecomputeAllReferenceCounts(ctx, tid); err != nil && rf.Logger != nil {
			rf.Logger.Warn("assets refresher: recompute", "tenant", tid, "err", err)
		}
	}
}
