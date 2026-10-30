// SPDX-License-Identifier: AGPL-3.0-only
//
// membership_refresh.go — one cache rewrite as a worker runs it: its own
// tenant transaction, then the segment_joined forwards once it commits.
//
// Both cache workers call RefreshAndForwardEntrants. The send-time materialiser
// used to rewrite with entrant detection off, so every subscriber who entered a
// segment without an event reaching the event worker — a profile edit, an
// import, a tag or list change, a date rule coming true, a segment past the
// per-event enqueue cap — was folded into the baseline by the materialiser and
// never fired "Entered segment". A materialiser rewrite that landed between an
// event and the event worker's refresh swallowed that event's entrants the
// same way. Whichever worker rewrites the cache is now the one that reports who
// entered; the per-segment lock in RefreshMembershipCache stops the other from
// reporting them again.

package segments

import (
	"context"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RefreshAndForwardEntrants rewrites one segment's membership cache in its own
// tenant-scoped transaction and, once that has committed, forwards a
// segment_joined event per entrant to f. Detection runs only when f would
// deliver (see ForwardingEnabled). worker names the caller in logs.
func RefreshAndForwardEntrants(ctx context.Context, pool *db.Pool, tenantID, segmentID string, f SegmentJoinForwarder, logger *slog.Logger, worker string) (MembershipRefresh, error) {
	if logger == nil {
		logger = slog.Default()
	}
	logger = logger.With("worker", worker, "tenant_id", tenantID, "segment_id", segmentID)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return MembershipRefresh{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Entry events need a baseline to diff against. On a segment's first
	// rewrite, or the first after its definition changed, every member would
	// look like a fresh entrant, so RefreshMembershipCache detects nothing and
	// only records the baseline.
	result, err := RefreshMembershipCache(ctx, tx, tenantID, segmentID, MembershipRefreshOptions{
		DetectEntrants: ForwardingEnabled(f),
	})
	if err != nil {
		return MembershipRefresh{}, err
	}
	if result.EntrantDetectionErr != nil {
		logger.Warn("segment membership: entrant detection failed; membership was still refreshed",
			"err", result.EntrantDetectionErr)
	}
	if result.EntrantsCapped {
		logger.Warn("segment membership: entrant fan-out capped", "cap", entrantForwardCap)
	}
	if result.Superseded {
		logger.Info("segment membership: segment edited during the rewrite; baseline left for the next rewrite")
	}
	if err := tx.Commit(ctx); err != nil {
		return MembershipRefresh{}, err
	}

	// Dispatch only after the rewrite committed, so a rolled-back refresh
	// never fires a spurious trigger. Detached + fire-and-forget: a slow
	// automation runtime must not stall either worker's tick.
	dispatchSegmentJoins(logger, f, result.Entrants)
	return result, nil
}

// ForwardingEnabled reports whether a detected entrant would be delivered
// anywhere. A forwarder that can say it is switched off (an
// HTTPSegmentJoinForwarder with no automation runtime configured) is taken at
// its word, and the workers skip the diff instead of computing entrants nobody
// receives.
func ForwardingEnabled(f SegmentJoinForwarder) bool {
	if f == nil {
		return false
	}
	if gate, ok := f.(interface{ Enabled() bool }); ok {
		return gate.Enabled()
	}
	return true
}

// dispatchSegmentJoins forwards a segment_joined event per entrant on a
// detached goroutine (best-effort). No-op when there is nothing to send.
func dispatchSegmentJoins(logger *slog.Logger, f SegmentJoinForwarder, entrants []SegmentJoinEvent) {
	if f == nil || len(entrants) == 0 {
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Error("segment membership: entrant dispatch panicked", "panic", r)
			}
		}()
		for _, ev := range entrants {
			if err := f.ForwardSegmentJoined(context.Background(), ev); err != nil {
				logger.Warn("segment membership: segment_joined forward failed", "err", err)
			}
		}
	}()
}
