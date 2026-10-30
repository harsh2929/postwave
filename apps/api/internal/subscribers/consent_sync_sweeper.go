// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The worker that drains the consent-sync ledger.
//
// `RunRetrySweep` shipped complete — it claims due rows, re-attempts delivery,
// applies bounded backoff, and gives up at the attempt cap — and had no
// non-test caller. So the first delivery attempt was the only one that ever
// happened. A destination that was briefly down, rate-limiting, or mid-deploy
// kept the consent change forever: the row sat in `retrying` with a
// `next_attempt_at` no worker ever read.
//
// For the question this subsystem exists to answer — "you were told to stop;
// who else holds this record and were they told?" — "we tried once, it failed,
// and nobody looked again" is not a materially better answer than never having
// tried.
//
// Per-tenant rather than one global pass because `RunRetrySweep` runs inside
// `db.WithTenant`, which is what makes RLS enforce isolation on the retry path
// exactly as it does on the write path. The tenant discovery query is the only
// part that has to see across tenants, and it reads nothing but tenant ids.

// ConsentSyncSweeper periodically drains due consent-sync ledger rows.
type ConsentSyncSweeper struct {
	Pool   *db.Pool
	Ledger *ConsentSyncLedger
	Logger *slog.Logger
	// Interval defaults to 1 minute when zero. The ledger's own backoff
	// schedule (~1m, 5m, 30m, 3h) sets the real pace; this only governs how
	// promptly a due row is noticed.
	Interval time.Duration
	// BatchLimit caps rows processed per tenant per tick. Zero means the
	// ledger's own default.
	BatchLimit int
}

func (s *ConsentSyncSweeper) log() *slog.Logger {
	if s == nil || s.Logger == nil {
		return slog.Default()
	}
	return s.Logger
}

// Run ticks until the context is cancelled.
func (s *ConsentSyncSweeper) Run(ctx context.Context) {
	if s == nil || s.Pool == nil || s.Ledger == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick runs one pass and returns the number of rows processed.
func (s *ConsentSyncSweeper) tick(ctx context.Context) int {
	if s == nil || s.Pool == nil || s.Ledger == nil {
		return 0
	}
	tenants, err := s.tenantsWithDueRows(ctx)
	if err != nil {
		s.log().Warn("consent sync sweep: tenant discovery failed", "err", err.Error())
		return 0
	}
	processed := 0
	for _, tenantID := range tenants {
		n, err := s.Ledger.RunRetrySweep(ctx, tenantID, s.BatchLimit)
		processed += n
		if err != nil {
			// One tenant's failure must not stop the others: a single
			// misconfigured destination would otherwise stall every other
			// tenant's consent propagation behind it.
			s.log().Warn("consent sync sweep: tenant sweep failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return processed
}

// tenantsWithDueRows lists the tenants holding at least one row whose retry is
// due.
//
// Goes through `consent_sync_due_tenants()`, a SECURITY DEFINER function, and
// not through the `app.outbox_worker` policy bypass this repo uses elsewhere:
// `consent_sync_ledger`'s tenant_isolation policy is RESTRICTIVE, so it ANDs
// with every other policy and no permissive addition can widen past
// `tenant_id = current_setting('app.tenant_id')`. That restriction is correct
// for a consent ledger and not worth trading away for a worker's convenience.
//
// The function is also narrower than a policy would have been. A policy exposes
// whole ROWS to whatever query the worker writes; this exposes one projection —
// the set of tenant ids with due work — and no subscriber id, destination URL,
// event type, or write path. Everything else happens inside db.WithTenant under
// the ordinary policy.
func (s *ConsentSyncSweeper) tenantsWithDueRows(ctx context.Context) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT consent_sync_due_tenants()::text`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
