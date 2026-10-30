// SPDX-License-Identifier: AGPL-3.0-only
//
// dedicated_ip_snapshot.go — background worker that samples per-IP
// reputation + drives auto-rotation.
//
// Each tick:
//
//   1. Read every active dedicated IP across every tenant.
//   2. For each IP, pull its current blocklist + bounce + complaint
//      stats from the deliverability service via ReputationSampler.
//   3. Persist a snapshot row to ip_reputation_snapshots.
//   4. If the IP's EngagementMultiplier hits 0 (engagement critical)
//      OR the IP has a tier-1 blocklist hit, mark the assignment
//      'draining' so the dispatcher routes new traffic away.
//   5. Prune snapshots older than 7 days.

package sending

import (
	"context"
	"log/slog"
	"time"
)

// ReputationSampler is the interface the snapshot worker reads
// from. Concrete implementations live elsewhere — typically a thin
// HTTP client against the deliverability service's /v1/reputation
// endpoint, or a Postgres view that joins the relevant tables.
type ReputationSampler interface {
	// Sample returns the current IPReputation snapshot for ip. The
	// caller fills in IP + Pool fields; the implementation populates
	// BlocklistHits, BounceRate7d, ComplaintRate7d, SenderScore.
	Sample(ctx context.Context, ip string) (IPReputation, error)
}

// SnapshotWorker drives the per-IP reputation refresh loop.
type SnapshotWorker struct {
	Repo     *DedicatedIPRepo
	Sampler  ReputationSampler
	Interval time.Duration // default 10min
	MaxAge   time.Duration // default 7 days (snapshot retention)
	Logger   *slog.Logger
}

// NewSnapshotWorker constructs a worker with defaults.
func NewSnapshotWorker(repo *DedicatedIPRepo, sampler ReputationSampler, logger *slog.Logger) *SnapshotWorker {
	return &SnapshotWorker{
		Repo:     repo,
		Sampler:  sampler,
		Interval: 10 * time.Minute,
		MaxAge:   7 * 24 * time.Hour,
		Logger:   logger,
	}
}

// Run drives the worker until ctx is canceled.
func (w *SnapshotWorker) Run(ctx context.Context) error {
	if w == nil || w.Repo == nil || w.Sampler == nil {
		return nil
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("sending snapshot worker: starting", "interval", interval.String())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		// Run immediately, then tick.
		w.runOnce(ctx, logger)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *SnapshotWorker) runOnce(ctx context.Context, logger *slog.Logger) {
	started := time.Now()
	assigns, err := w.Repo.ListAllActive(ctx)
	if err != nil {
		logger.Warn("snapshot worker: list active failed", "err", err.Error())
		return
	}
	rotations := 0
	for _, a := range assigns {
		rep, err := w.Sampler.Sample(ctx, a.IP)
		if err != nil {
			logger.Debug("snapshot worker: sample failed",
				"ip", a.IP, "err", err.Error())
			continue
		}
		rep.IP = a.IP
		rep.Pool = a.Pool

		// Compute halt decision. Two triggers:
		//   1. Engagement-critical (multiplier=0): complaint ≥2% or
		//      bounce ≥10% in the 7d window.
		//   2. Tier-1 blocklist hit (recorded by the blocklist
		//      monitor — surfaced via BlocklistHits>0 on tier-1 zones
		//      by the sampler).
		halt := false
		reason := ""
		if rep.BlocklistHits > 0 {
			halt = true
			reason = HaltReasonBlocklistTier1
		} else {
			snapshot := EngagementSnapshot{
				Sent:       1000, // Snapshot must satisfy MinSampleSize check
				Bounced:    int64(rep.BounceRate7d * 1000),
				Complained: int64(rep.ComplaintRate7d * 1000),
			}
			if EngagementMultiplier(snapshot) == 0 {
				halt = true
				reason = HaltReasonEngagementCrit
			}
		}
		rep.Halted = halt
		if err := w.Repo.WriteSnapshot(ctx, a.TenantID, a.IP, a.Pool, rep); err != nil {
			logger.Warn("snapshot worker: write snapshot failed",
				"ip", a.IP, "err", err.Error())
			continue
		}
		if halt {
			if err := w.Repo.MarkDraining(ctx, a.ID, reason); err != nil {
				logger.Warn("snapshot worker: mark draining failed",
					"ip", a.IP, "assignment", a.ID, "err", err.Error())
				continue
			}
			rotations++
			logger.Info("snapshot worker: marked IP draining",
				"ip", a.IP, "tenant", a.TenantID, "reason", reason)
		}
	}
	if n, err := w.Repo.PruneOldSnapshots(ctx, w.MaxAge); err == nil && n > 0 {
		logger.Debug("snapshot worker: pruned snapshots", "rows", n)
	}
	logger.Debug("snapshot worker: pass complete",
		"assignments", len(assigns),
		"rotations", rotations,
		"elapsed", time.Since(started).String())
}

// StaticSampler is a test/dev ReputationSampler that returns canned
// values. Useful for wiring tests + local development without a live
// deliverability service.
type StaticSampler struct {
	Values map[string]IPReputation
}

// Sample implements ReputationSampler.
func (s *StaticSampler) Sample(_ context.Context, ip string) (IPReputation, error) {
	if rep, ok := s.Values[ip]; ok {
		return rep, nil
	}
	return IPReputation{IP: ip}, nil
}
