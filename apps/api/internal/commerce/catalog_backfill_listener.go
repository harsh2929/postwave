// SPDX-License-Identifier: AGPL-3.0-only
package commerce

// SUB-013 — catalog-linked profile attributes listener.
//
// BackfillCatalogAttributes (catalog_attributes.go) recomputes the
// favorite_category + last_viewed_sku traits for a tenant's subscribers
// from commerce_events. Historically it was exported but never called —
// dead code. This file is the seam that makes it live: every commerce-event
// ingest path that can attribute an event to a subscriber by email
// (Repo.Sync, Repo.UpsertCustomer, Repo.UpsertOrder) fires the listener
// AFTER the ingesting transaction has committed, so the freshly-written
// commerce_events rows are visible to the backfill query.
//
// Design choices:
//   - Tenant-scoped: the backfill runs under db.WithTenant for the same
//     tenant whose events were ingested; it never reads cross-tenant rows.
//   - Non-blocking: the trigger spawns a goroutine with a fresh, bounded
//     context (NOT the request context, which is cancelled the moment the
//     HTTP response flushes). The ingest handler returns immediately; trait
//     recomputation happens out of band.
//   - Safe: failures are logged (best-effort) and never propagate back into
//     the ingest path — a trait recompute hiccup must not fail an order
//     webhook. The backfill itself is idempotent (it overwrites the two
//     traits), so a missed run self-heals on the next ingest.
//
// We deliberately do NOT route this through events.Bus: that bus is an
// outbound SSE fan-out to desktop/mobile clients (campaign.*, subscriber.*),
// not an internal work queue. Hooking the ingest path directly keeps the
// trigger synchronous-with-commit and avoids coupling a backend recompute to
// the presence/SSE infrastructure.

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// catalogBackfillTimeout bounds a single listener run so a slow trait
// recompute can't leak a goroutine indefinitely.
const catalogBackfillTimeout = 2 * time.Minute

// CatalogBackfillListener invokes Repo.BackfillCatalogAttributes for a tenant
// when commerce events are ingested. The zero value is unusable; build one
// with NewCatalogBackfillListener so the *Repo and logger are wired.
type CatalogBackfillListener struct {
	repo   *Repo
	logger *slog.Logger

	// async controls whether Trigger spawns a goroutine (production) or runs
	// the backfill inline (tests, where we want a deterministic result). It
	// defaults to true; tests flip it via NewSyncCatalogBackfillListener.
	async bool

	// wg lets tests wait for in-flight async runs to finish before asserting.
	wg sync.WaitGroup
}

// NewCatalogBackfillListener returns a production listener that fires the
// backfill on a background goroutine. logger may be nil (failures are then
// silently swallowed — the backfill self-heals on the next ingest).
func NewCatalogBackfillListener(repo *Repo, logger *slog.Logger) *CatalogBackfillListener {
	return &CatalogBackfillListener{repo: repo, logger: logger, async: true}
}

// NewSyncCatalogBackfillListener returns a listener that runs the backfill
// inline (synchronously) on Trigger. For tests that need to assert the traits
// were written without racing a goroutine.
func NewSyncCatalogBackfillListener(repo *Repo, logger *slog.Logger) *CatalogBackfillListener {
	return &CatalogBackfillListener{repo: repo, logger: logger, async: false}
}

// Trigger recomputes the catalog traits for every attributable subscriber in
// the tenant. It is safe to call with a nil receiver (no-op) so ingest paths
// can call r.CatalogBackfill.Trigger unconditionally behind a nil check on
// the field. since=zero means "all time" (idempotent full recompute).
func (l *CatalogBackfillListener) Trigger(tenantID string, since time.Time) {
	if l == nil || l.repo == nil || tenantID == "" {
		return
	}
	if !l.async {
		l.run(context.Background(), tenantID, since)
		return
	}
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		// Fresh, bounded context — the request context is gone once the
		// ingest handler has responded.
		ctx, cancel := context.WithTimeout(context.Background(), catalogBackfillTimeout)
		defer cancel()
		l.run(ctx, tenantID, since)
	}()
}

// run executes the backfill and logs the outcome best-effort.
func (l *CatalogBackfillListener) run(ctx context.Context, tenantID string, since time.Time) {
	results, err := l.repo.BackfillCatalogAttributes(ctx, tenantID, since)
	if err != nil {
		if l.logger != nil {
			l.logger.Warn("catalog attributes backfill failed", "tenant", tenantID, "err", err.Error())
		}
		return
	}
	if l.logger != nil && len(results) > 0 {
		l.logger.Info("catalog attributes backfill complete", "tenant", tenantID, "subscribers_updated", len(results))
	}
}

// Wait blocks until all in-flight async runs complete. Test-only helper.
func (l *CatalogBackfillListener) Wait() {
	if l == nil {
		return
	}
	l.wg.Wait()
}

// triggerCatalogBackfill is the internal hook the ingest paths call after a
// successful commit. nil-listener-safe.
func (r *Repo) triggerCatalogBackfill(tenantID string) {
	if r == nil || r.CatalogBackfill == nil {
		return
	}
	// since=zero → recompute over all of the tenant's commerce_events. The
	// backfill is idempotent, so re-running on every ingest is correct (if
	// wasteful at very high event volume; a future optimisation can bound
	// the window or debounce per tenant).
	r.CatalogBackfill.Trigger(tenantID, time.Time{})
}
