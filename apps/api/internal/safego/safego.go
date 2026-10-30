// Package safego provides a panic-safe goroutine spawner for the
// API's background workers. An unrecovered panic in any goroutine
// crashes the entire Go process — this wrapper turns a worker
// panic into a logged event plus an early goroutine return, so a
// transient bug in one worker can't take down the whole API.
//
// Usage:
//
//	safego.Go(logger, "outbox-worker", func() {
//	    if err := outboxWorker.Run(ctx); err != nil &&
//	        !errors.Is(err, context.Canceled) {
//	        logger.Warn("outbox worker exited", "err", err.Error())
//	    }
//	})
//
// The wrapper logs at slog.LevelError with the worker name, the
// recovered value, and the goroutine's stack so the operator can
// diagnose without grepping through logs.
//
// Graceful shutdown: callers can install a process-wide WaitGroup via
// SetWaitGroup before spawning any workers. Every subsequent Go call
// will Add(1) before the goroutine starts and Done() after it exits
// (including after a panic), so the shutdown sequence can Wait() on
// outstanding workers to complete after cancelling their context.
package safego

import (
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

// trackedWG is the process-wide WaitGroup that Go increments before
// spawning and decrements after the worker exits. nil by default —
// callers opt in by calling SetWaitGroup. Guarded by trackedMu so
// concurrent SetWaitGroup / Go calls during boot don't race.
var (
	trackedMu sync.RWMutex
	trackedWG *sync.WaitGroup
)

// Observer is notified when a safego worker starts and when it exits. It is
// the fleet seam: every background worker in the API is spawned through Go, so
// one observer here learns the shape of all of them without 81 call sites
// having to remember to report anything.
//
// What an Observer can honestly know is LIFECYCLE — started, exited, exited by
// panic. It cannot know whether a still-running worker is doing any work, so a
// consumer must not present these events as a liveness heartbeat. A deadlocked
// worker never exits and is, to this interface, indistinguishable from a busy
// one.
//
// Implementations must be non-blocking and safe for concurrent use: they run
// on the worker's own goroutine, on its hot path at start and on its deferred
// exit path.
type Observer interface {
	WorkerStarted(name string)
	// WorkerExited reports the worker returning. panicked distinguishes a
	// recovered panic from an ordinary return -- both end the worker, but only
	// one of them is a bug.
	WorkerExited(name string, panicked bool)
}

var (
	observerMu sync.RWMutex
	observer   Observer
)

// SetObserver installs the process-wide Observer. Pass nil to disable
// reporting (the default). Safe to call concurrently with Go.
func SetObserver(o Observer) {
	observerMu.Lock()
	observer = o
	observerMu.Unlock()
}

func currentObserver() Observer {
	observerMu.RLock()
	defer observerMu.RUnlock()
	return observer
}

// notify runs an observer callback with its own recover.
//
// This package exists so a worker bug cannot take down the process. An
// observer bug taking down the worker it observes would be a strictly worse
// version of the same failure -- monitoring that kills what it monitors -- so
// the callback gets the same containment the worker does.
func notify(logger *slog.Logger, call func(Observer)) {
	o := currentObserver()
	if o == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil && logger != nil {
			logger.Error("safego: observer panic", "panic", fmt.Sprint(r))
		}
	}()
	call(o)
}

// SetWaitGroup installs the process-wide WaitGroup that subsequent
// Go calls participate in. Pass nil to disable tracking (the default).
//
// Safe to call concurrently with Go; existing in-flight workers retain
// the WaitGroup they were spawned with.
func SetWaitGroup(wg *sync.WaitGroup) {
	trackedMu.Lock()
	trackedWG = wg
	trackedMu.Unlock()
}

// Wait blocks until either every safego-spawned worker has exited or
// the given timeout elapses. Returns true when all workers exited
// cleanly within the timeout, false on timeout.
//
// A nil installed WaitGroup returns true immediately.
func Wait(timeout time.Duration) bool {
	trackedMu.RLock()
	wg := trackedWG
	trackedMu.RUnlock()
	if wg == nil {
		return true
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Go spawns fn in a new goroutine, recovering any panic and logging
// it via logger. The name is opaque — use whatever identifies the
// worker in operator dashboards.
//
// logger MAY be nil; if so, the recover is silent (the panic is
// still swallowed, the goroutine still exits cleanly).
//
// If a process-wide WaitGroup is installed (see SetWaitGroup), Go
// participates: Add(1) is called synchronously before the goroutine
// starts and Done() is deferred inside the goroutine so shutdown
// drainers see an accurate worker count.
func Go(logger *slog.Logger, name string, fn func()) {
	trackedMu.RLock()
	wg := trackedWG
	trackedMu.RUnlock()
	if wg != nil {
		wg.Add(1)
	}
	go func() {
		panicked := false
		defer func() {
			if wg != nil {
				wg.Done()
			}
		}()
		// Ordered after the recover below (defers run LIFO), so panicked is
		// already set by the time the exit is reported.
		defer func() { notify(logger, func(o Observer) { o.WorkerExited(name, panicked) }) }()
		defer func() {
			if r := recover(); r != nil {
				panicked = true
				if logger != nil {
					logger.Error("safego: goroutine panic",
						"worker", name,
						"panic", fmt.Sprint(r),
						"stack", string(debug.Stack()))
				}
			}
		}()
		notify(logger, func(o Observer) { o.WorkerStarted(name) })
		fn()
	}()
}
