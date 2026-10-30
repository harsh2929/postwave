// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const (
	defaultTick         = 60 * time.Second
	defaultProbeTimeout = 10 * time.Second
	maxConcurrentProbes = 8
)

type Reconciler struct {
	Store        *Store
	Env          *Env
	Logger       *slog.Logger
	ProbeTimeout time.Duration
	Now          func() time.Time // injectable for tests

	// Heartbeat, when set, is beaten at the end of every completed tick. It
	// distinguishes "the platform is on fire" from "the reconciler died and
	// every check therefore aged out" — two boards that otherwise look
	// identical and want opposite responses. Optional: a nil Heartbeat is a
	// no-op, so tests and cmd/opsdemo need not wire one.
	Heartbeat *Heartbeat
}

func (rc *Reconciler) now() time.Time {
	if rc.Now != nil {
		return rc.Now()
	}
	return time.Now().UTC()
}

// Run ticks forever. If it dies, every evaluated check exceeds 2*Interval and
// the board turns RED. It does not turn stale-green. That is the whole point:
// the board fails safe.
func (rc *Reconciler) Run(ctx context.Context) {
	t := time.NewTicker(defaultTick)
	defer t.Stop()

	rc.Tick(ctx) // once at boot, so the board is populated immediately

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rc.Tick(ctx)
		}
	}
}

func (rc *Reconciler) Tick(ctx context.Context) {
	now := rc.now()

	prevs, err := rc.Store.LoadAll(ctx)
	if err != nil {
		rc.Logger.Error("ops: could not load check results", "err", err)
		return
	}

	sem := make(chan struct{}, maxConcurrentProbes)
	var wg sync.WaitGroup

	for _, c := range All() {
		if c.Kind != KindEvaluated {
			continue // heartbeats report themselves; manual checks are ticked by a human
		}
		// A blocked check has no working dependency to probe. Running it would
		// burn a timeout and write a RED row every tick for something no
		// engineer can fix; Effective() already derives StatusBlocked from the
		// registry, so the board stays honest without the noise.
		if c.Blocked != nil {
			continue
		}
		prev := prevs[c.ID]

		// Interval is the run cadence as well as the freshness budget. A
		// 12h cert-expiry probe therefore does not hammer ACM every minute.
		if now.Sub(prev.LastReportedAt) < c.Interval {
			continue
		}

		wg.Add(1)
		go func(c Check, prev Result) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			st, detail := rc.runProbe(ctx, c)
			if err := rc.Store.Upsert(ctx, c.ID, prev, st, detail, now); err != nil {
				rc.Logger.Error("ops: could not persist check result", "check", c.ID, "err", err)
			}
		}(c, prev)
	}

	wg.Wait()

	// Beaten AFTER the wait, so the beat means "a full tick completed", not
	// "a tick was started". A reconciler wedged inside a probe would otherwise
	// keep reporting itself healthy while doing nothing.
	rc.Heartbeat.Beat(ctx)
}

// runProbe never returns "unknown". A panic, a timeout, or an error is RED.
//
// The zero value of the named returns is RED by construction, so any path out
// of this function that forgets to set a status still fails safe.
func (rc *Reconciler) runProbe(ctx context.Context, c Check) (st Status, detail string) {
	st, detail = StatusRed, "probe did not complete"

	defer func() {
		if r := recover(); r != nil {
			st = StatusRed
			detail = fmt.Sprintf("probe panicked: %v", r)
		}
	}()

	timeout := rc.ProbeTimeout
	if timeout == 0 {
		timeout = defaultProbeTimeout
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	probe := probeFor(c)
	if probe == nil {
		// Only reachable if a runtime probe went unbound AND boot validation
		// was bypassed. Reported, never skipped: a check that silently does
		// not run is indistinguishable from a check that passes.
		return StatusRed, "probe is not bound; this is a wiring bug, not a platform fault"
	}

	s, d, err := probe(pctx, rc.Env)
	if err != nil {
		return StatusRed, "probe failed: " + err.Error()
	}
	return s, d
}
