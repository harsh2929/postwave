// SPDX-License-Identifier: AGPL-3.0-only
package outbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Worker drains the outbox: every PollInterval it claims a batch of
// available events and dispatches each to the registered handler.
//
// Concurrency model: one Worker per process is enough. Multiple processes
// may run their own Worker against the same DB — claims are atomic
// (FOR UPDATE SKIP LOCKED) so no row is dispatched twice.
type Worker struct {
	Store    Store
	Registry *Registry
	OwnerID  string

	// PollInterval — how often to poll when the queue is empty. Defaults
	// to DefaultPollInterval. When the previous tick claimed a non-zero
	// batch the worker re-runs immediately, so this only governs idle.
	PollInterval time.Duration
	// LeaseTTL — how long a claimed row stays leased. Defaults to
	// DefaultLeaseTTL.
	LeaseTTL time.Duration
	// ClaimBatch — max events fetched per tick. Defaults to
	// DefaultClaimBatch.
	ClaimBatch int
	// HandlerTimeout — max wall time a handler may run before its ctx is
	// cancelled. Should be < LeaseTTL so we don't lose the lease while the
	// handler is still working. Zero → LeaseTTL/2.
	HandlerTimeout time.Duration

	Logger *slog.Logger

	// heartbeat is beaten after every completed loop iteration. See
	// SetHeartbeat -- it is deliberately NOT an exported field.
	heartbeat atomic.Pointer[Beater]
}

// Beater receives a signal that a loop iteration completed. *ops.Heartbeat
// satisfies it; a nil Beater is a no-op, because a monitoring hook must never
// be able to break the worker it monitors.
type Beater interface {
	Beat(ctx context.Context)
}

// SetHeartbeat installs the loop's heartbeat. Safe to call while the worker is
// already running, which is the only way it can be called: the outbox starts
// early in boot and the ops store it beats into is built hundreds of lines
// later, so a plain exported field would be a data race on a live worker.
//
// The signal itself is the difference between "the goroutine exists" and "the
// drain is draining". A worker blocked on a held lock or an exhausted pool
// stays alive indefinitely while every queued send sits in the database and
// nothing errors -- the failure this exists to make visible.
//
// Narrowly typed on purpose: outbox must not learn about the ops console in
// order to be monitored by it.
func (w *Worker) SetHeartbeat(b Beater) {
	if b == nil {
		w.heartbeat.Store(nil)
		return
	}
	w.heartbeat.Store(&b)
}

// NewWorker constructs a Worker with sane defaults.
func NewWorker(store Store, registry *Registry) *Worker {
	return &Worker{
		Store:          store,
		Registry:       registry,
		OwnerID:        newOwnerID(),
		PollInterval:   DefaultPollInterval,
		LeaseTTL:       DefaultLeaseTTL,
		ClaimBatch:     DefaultClaimBatch,
		HandlerTimeout: DefaultLeaseTTL / 2,
	}
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// Run starts the worker loop. It blocks until ctx is canceled.
//
// Loop shape:
//
//	while !ctx.Done():
//	    n = tick()
//	    if n == 0: sleep PollInterval
//	    else:      yield (loop again immediately)
//
// This way bursts drain at the speed of the handlers, not the poll
// interval, while idle workers don't hammer the DB.
func (w *Worker) Run(ctx context.Context) error {
	if w.Store == nil || w.Registry == nil {
		return errors.New("outbox: Worker requires Store and Registry")
	}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := w.tick(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			w.log().Warn("outbox: tick failed", "err", err.Error())
		}
		// Beaten on every completed iteration INCLUDING a failed or empty
		// one. The claim is "this loop is turning over", not "this loop is
		// succeeding" — an idle queue is healthy, and a tick that errors is
		// still a tick that ran. Health of the work itself is the outbox
		// backlog's job, not the heartbeat's.
		if hb := w.heartbeat.Load(); hb != nil {
			(*hb).Beat(ctx)
		}
		if n > 0 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(w.PollInterval):
		}
	}
}

// tick claims one batch and dispatches each event. Returns the number of
// events dispatched (regardless of handler success).
func (w *Worker) tick(ctx context.Context) (int, error) {
	events, err := w.Store.Claim(ctx, w.OwnerID, w.LeaseTTL, w.ClaimBatch)
	if errors.Is(err, ErrNoEvents) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var wg sync.WaitGroup
	for _, ev := range events {
		wg.Add(1)
		go func(ev Event) {
			defer wg.Done()
			w.dispatch(ctx, ev)
		}(ev)
	}
	wg.Wait()
	return len(events), nil
}

// dispatch runs the handler for one event, then Complete/Fail per result.
// bookkeepingTimeout caps how long Complete/Fail may run during
// graceful shutdown.
//
// Why 30s and not 5s: under DB pressure, a single Complete is an
// open-tx + set_config + UPDATE + commit — multiple round-trips. If
// bookkeeping is cancelled mid-flight, the row's `claimed_until` is
// NEVER cleared, so the lease has to time out and another worker
// re-claims the row → duplicate dispatch (the exact failure mode this
// detached context is meant to prevent). 30s is comfortably longer
// than the default lease TTL window where it matters and short enough
// that pathological hangs still surface promptly in metrics.
const bookkeepingTimeout = 30 * time.Second

// bookkeepingCtx returns a detached context for terminal Complete/Fail
// calls. Using the live worker ctx (which graceful-shutdown cancels)
// would lose successful handler completions: handler ran, side effect
// landed, but Complete fails with context.Canceled, lease expires, next
// worker re-claims the row, handler runs AGAIN. That's exactly the
// at-least-once-becomes-at-least-twice failure the outbox is meant to
// prevent. Mirrors the pattern used by migrationrunner's pg_advisory_unlock.
func bookkeepingCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), bookkeepingTimeout)
}

func (w *Worker) dispatch(parent context.Context, ev Event) {
	fn, ok := w.Registry.Lookup(ev.Kind)
	if !ok {
		// No handler. Park the row in the DLQ so it doesn't keep
		// re-running forever; an operator can backfill the handler and
		// reprocess from there.
		w.log().Warn("outbox: no handler for kind, sending to DLQ",
			"kind", ev.Kind, "event_id", ev.ID, "tenant_id", ev.TenantID)
		bk, bcancel := bookkeepingCtx()
		defer bcancel()
		_ = w.Store.Fail(bk, ev.ID, w.OwnerID,
			fmt.Sprintf("no handler registered for kind %q", ev.Kind),
			time.Time{}, true)
		return
	}

	hctx, cancel := context.WithTimeout(parent, w.HandlerTimeout)
	defer cancel()

	err := safeRun(hctx, fn, ev)

	// Terminal bookkeeping (Complete/Fail) ALWAYS runs against a
	// detached context — never the worker-loop ctx. If we used `parent`
	// here, graceful shutdown would cancel the bookkeeping mid-flight
	// and the row's lease would just expire, leading to duplicate
	// dispatch on next claim.
	bk, bcancel := bookkeepingCtx()
	defer bcancel()

	if err == nil {
		if cerr := w.Store.Complete(bk, ev.ID, w.OwnerID); cerr != nil {
			w.log().Warn("outbox: complete failed",
				"event_id", ev.ID, "kind", ev.Kind, "err", cerr.Error())
		}
		return
	}

	dead := ev.Attempts >= ev.MaxAttempts
	retryAt := time.Now().Add(time.Duration(BackoffSeconds(ev.Attempts)) * time.Second)
	if ferr := w.Store.Fail(bk, ev.ID, w.OwnerID, err.Error(), retryAt, dead); ferr != nil {
		w.log().Warn("outbox: fail bookkeeping failed",
			"event_id", ev.ID, "kind", ev.Kind, "err", ferr.Error())
	}
	if dead {
		w.log().Error("outbox: event sent to DLQ",
			"event_id", ev.ID, "kind", ev.Kind, "attempts", ev.Attempts,
			"err", err.Error())
	} else {
		w.log().Info("outbox: event will retry",
			"event_id", ev.ID, "kind", ev.Kind, "attempts", ev.Attempts,
			"retry_at", retryAt.Format(time.RFC3339), "err", err.Error())
	}
}

// safeRun catches panics in handlers so one bad row doesn't tear down
// the whole worker process.
func safeRun(ctx context.Context, fn HandlerFunc, ev Event) (out error) {
	defer func() {
		if r := recover(); r != nil {
			out = fmt.Errorf("handler panic: %v", r)
		}
	}()
	return fn(ctx, ev)
}

// newOwnerID returns a fresh per-process UUID-shaped id used as the lease
// owner in outbox_events. Same shape as services/migration's owner.
func newOwnerID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		seed := fmt.Sprintf("outbox:%d:%d:%v", os.Getpid(), time.Now().UnixNano(), err)
		sum := sha256.Sum256([]byte(seed))
		copy(b[:], sum[:16])
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
