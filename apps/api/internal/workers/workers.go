// SPDX-License-Identifier: AGPL-3.0-only
//
// Package workers owns the long-running goroutines launched alongside
// the HTTP surface (deliverability-hub recompute, outbox flush,
// commerce-lifecycle, send-time optimizer, ...).
//
// In the current main.go monolith, each worker is spun up with an ad
// hoc `safego.Go(logger, "name", func() { (&pkg.Worker{...}).Run(ctx) })`
// block. This package centralises the registration so:
//
//   - Workers can be discovered (and disabled per-env) via a single
//     slice.
//   - The lifecycle context is owned in one place — Run blocks until
//     ctx is cancelled, then returns when every worker has exited.
//   - Tests can run a subset of workers without booting the full HTTP
//     surface.
//
// As with server.Mount* helpers, workers migrate out of main.go
// incrementally. The initial Worker set here mirrors the
// deliverability_hub worker that ships with server.MountDeliverabilitySurface;
// everything else stays in main.go until its mount block
// also moves.
package workers

import (
	"context"
	"sync"

	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/server"
)

// Worker is a single long-running goroutine. Name is used for log
// scoping and metric labels; Run blocks until ctx is cancelled and
// must be safe to call exactly once per process.
type Worker struct {
	Name string
	Run  func(ctx context.Context)
}

// Registered returns the canonical worker list assembled from the
// current server.Deps. New workers are added here as their mount
// blocks migrate out of main.go.
//
// The function intentionally returns a fresh slice on each call so
// the caller can filter (e.g. skip workers in test mode) without
// mutating shared state.
func Registered(deps server.Deps) []Worker {
	out := []Worker{}

	// Deliverability Hub recompute + auto-throttle worker. Mirrors
	// the safego.Go("deliverability-hub-worker", ...) block that
	// previously lived inline in main.go alongside the mount.
	//
	// NOT THE LIVE PATH. main.go composes its own deliverability_hub.Deps via
	// server.MountDeliverabilitySurface and starts the worker with
	// StartDeliverabilityHub; nothing calls Registered/Run yet. That matters
	// for one field in particular: the live composition also assigns
	// `HealthNotifier` (DELIVERABILITY#15), and a Deps built here would run the
	// same scoring and throttling while telling nobody. Carry the notifier over
	// before this becomes the live path.
	if deps.Pool != nil {
		hubDeps := &deliverability_hub.Deps{
			Pool:   deps.Pool,
			Bus:    deps.Bus,
			Logger: deps.Logger,
		}
		out = append(out, Worker{
			Name: "deliverability-hub-worker",
			Run: func(ctx context.Context) {
				// Worker.Run returns an error; surface it via the
				// logger so we don't silently lose retry signal.
				if err := (&deliverability_hub.Worker{Deps: hubDeps}).Run(ctx); err != nil {
					deps.Log().Warn("deliverability-hub worker exited",
						"err", err.Error())
				}
			},
		})
	}

	return out
}

// Run launches every Registered worker under safego.Go and blocks
// until ctx is cancelled. Each worker gets its own goroutine; Run
// returns when every spawned goroutine has exited (so callers can
// rely on it for graceful shutdown ordering).
func Run(ctx context.Context, deps server.Deps) {
	workers := Registered(deps)
	if len(workers) == 0 {
		<-ctx.Done()
		return
	}

	var wg sync.WaitGroup
	for _, w := range workers {
		wg.Add(1)
		w := w
		safego.Go(deps.Log(), w.Name, func() {
			defer wg.Done()
			w.Run(ctx)
		})
	}

	<-ctx.Done()
	wg.Wait()
}
