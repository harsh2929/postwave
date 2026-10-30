// SPDX-License-Identifier: AGPL-3.0-only
//
// recorder.go — bounded async sink between RecorderMiddleware and the
// api_key_calls INSERT.
//
// Why this exists:
//   The original RecorderMiddleware spawned a fresh goroutine per
//   request (`go func() { repo.Insert(...) }()`). Under a burst of
//   API-key traffic — or a slow Postgres — this is an unbounded
//   goroutine fan-out: a DoS amplifier where each external request
//   pins a goroutine + a DB connection waiting on the pool. A
//   misbehaving downstream (network blip, hot-row lock) turns into
//   memory + connection exhaustion at the API tier.
//
// Design (mirrors apps/api/internal/archive/view_recorder.go):
//
//   - Bounded buffered channel (capacity = RecorderBufferSize).
//   - N background drain workers (RecorderWorkers), wrapped in
//     safego.Go so a panic in Insert (driver NPE on a wedged conn)
//     can't take down the whole API process.
//   - When the buffer is full, Enqueue drops the row, increments
//     apikey_calls_recorder_dropped_total{reason=buffer_full}, and
//     returns false. Observability data is shed before user-visible
//     latency.
//   - Close() drains the buffer with a bounded deadline so SIGTERM
//     doesn't lose the in-flight tail.
//
// Backpressure rationale: this is observability, not load-bearing
// state. Dropping a row when the worker pool is saturated is
// preferable to amplifying a Postgres incident into an API outage
// via goroutine pile-up.

package apikeycalls

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/safego"
)

// Tunables — exported as vars so ops can pin smaller values in
// tests / specialised callers without a redeploy.
var (
	// RecorderBufferSize is the channel capacity. At ~5 ms per
	// INSERT and 4 workers ≈ 800 events/s of sustained throughput;
	// the buffer absorbs bursts up to ~10 s of full-pipe traffic.
	RecorderBufferSize = 4096

	// RecorderWorkers is the number of concurrent drain workers. 4
	// keeps connection-pool pressure low while giving us
	// substantially more throughput than the synchronous baseline.
	RecorderWorkers = 4

	// RecorderInsertTimeout is the per-attempt DB call deadline. The
	// recorder is best-effort: we don't retry — a single transient
	// failure simply drops one observability row.
	RecorderInsertTimeout = 5 * time.Second

	// RecorderShutdownTimeout caps how long Close() waits for the
	// drain. Sized so a normal SIGTERM (≈30 s grace) still has slack
	// for the rest of graceful shutdown to run.
	RecorderShutdownTimeout = 10 * time.Second
)

// recorderSink is the storage hook the recorder calls. Defined as an
// interface so tests can substitute a deterministic stub without
// standing up the full Pool. In production this is *Repo.
type recorderSink interface {
	Insert(ctx context.Context, c *Call) error
}

// Recorder is the async write-behind buffer that backs
// RecorderMiddleware. Zero value is NOT usable — call NewRecorder.
type Recorder struct {
	sink   recorderSink
	ch     chan Call
	wg     sync.WaitGroup
	gate   sync.RWMutex
	closed bool
	logger *slog.Logger
}

// NewRecorder constructs a Recorder and starts its worker goroutines.
// Callers SHOULD invoke Close() during graceful shutdown to drain
// in-flight events.
//
// `logger` may be nil; slog.Default() is used in that case.
//
// Env overrides (handy for ops without a redeploy):
//   - POSTWAVE_API_KEY_CALLS_BUFFER_SIZE
//   - POSTWAVE_API_KEY_CALLS_WORKERS
func NewRecorder(sink recorderSink, logger *slog.Logger) *Recorder {
	if v := os.Getenv("POSTWAVE_API_KEY_CALLS_BUFFER_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			RecorderBufferSize = n
		}
	}
	if v := os.Getenv("POSTWAVE_API_KEY_CALLS_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			RecorderWorkers = n
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	r := &Recorder{
		sink:   sink,
		ch:     make(chan Call, RecorderBufferSize),
		logger: logger,
	}
	for i := 0; i < RecorderWorkers; i++ {
		r.wg.Add(1)
		// safego.Go: a panic inside Insert (e.g. driver NPE on a
		// wedged connection) must not take down the API process —
		// the wrapper logs the stack and lets the worker exit.
		// We still need wg.Done() to fire so Close() unblocks even
		// after a panic; we wrap fn here so the defer beats the
		// safego recover in stack order.
		safego.Go(logger, "apikeycalls-recorder", func() {
			defer r.wg.Done()
			r.workerLoop()
		})
	}
	return r
}

// Enqueue is the non-blocking middleware-side entry point. Returns
// true when the event was buffered, false when dropped (buffer full
// OR recorder closed/nil). Callers should not log on `false` —
// apikey_calls_recorder_dropped_total is the canonical signal.
//
// Hot path: one channel send. No DB I/O, no log.
func (r *Recorder) Enqueue(c Call) bool {
	if r == nil {
		recorderDroppedTotal.WithLabelValues("nil_recorder").Inc()
		return false
	}
	// Hold a read gate through the non-blocking send. Close takes the write
	// gate before closing the channel, so there is no check-then-close window
	// in which an admitted producer can panic with "send on closed channel".
	r.gate.RLock()
	defer r.gate.RUnlock()
	if r.closed {
		recorderDroppedTotal.WithLabelValues("closed").Inc()
		return false
	}
	select {
	case r.ch <- c:
		recorderEnqueuedTotal.WithLabelValues("queued").Inc()
		return true
	default:
		// Buffer full — shed the row rather than block the HTTP
		// response or spawn an unbounded goroutine. The dropped
		// counter is the SLO-visible signal that ops uses to decide
		// whether to bump RecorderBufferSize or scale workers.
		recorderDroppedTotal.WithLabelValues("buffer_full").Inc()
		return false
	}
}

// QueueDepth returns the current number of buffered events. Useful
// for /metrics-adjacent debug endpoints and tests.
func (r *Recorder) QueueDepth() int {
	if r == nil {
		return 0
	}
	return len(r.ch)
}

// Close stops accepting new events and waits for the workers to
// drain. Bounded by RecorderShutdownTimeout so a misbehaving DB
// doesn't hang the entire process shutdown.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	r.gate.Lock()
	if r.closed {
		r.gate.Unlock()
		return
	}
	r.closed = true
	// Closing the channel signals workers to drain the remaining buffer. The
	// write gate proves every producer that passed the closed check has
	// completed its send before close(ch), and excludes new producers.
	close(r.ch)
	r.gate.Unlock()
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(RecorderShutdownTimeout):
		remaining := len(r.ch)
		if remaining > 0 && r.logger != nil {
			r.logger.Warn("apikeycalls: recorder shutdown timeout, dropped tail",
				slog.Int("remaining", remaining))
		}
		recorderDroppedTotal.WithLabelValues("shutdown_timeout").Add(float64(remaining))
	}
}

// workerLoop drains the buffered channel. Exits when the channel is
// closed AND drained. Per-event errors are dropped (this is
// observability, not state) but counted via recorderInsertTotal.
func (r *Recorder) workerLoop() {
	for c := range r.ch {
		r.processOne(c)
	}
}

func (r *Recorder) processOne(c Call) {
	ctx, cancel := context.WithTimeout(context.Background(), RecorderInsertTimeout)
	defer cancel()
	if err := r.sink.Insert(ctx, &c); err != nil {
		recorderInsertTotal.WithLabelValues("error").Inc()
		if r.logger != nil {
			r.logger.Debug("apikeycalls: recorder insert failed",
				slog.String("tenant_id", c.TenantID),
				slog.Any("err", err))
		}
		return
	}
	recorderInsertTotal.WithLabelValues("ok").Inc()
}

// ---------------------------------------------------------------------
// Prometheus surface
// ---------------------------------------------------------------------

var recorderEnqueuedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "apikey_calls_recorder_enqueued_total",
		Help: "RecorderMiddleware enqueue attempts, partitioned by outcome (queued).",
	},
	[]string{"outcome"},
)

// recorderDroppedTotal is the SLO signal for the bounded buffer.
// Labels:
//   - buffer_full      : Enqueue dropped because the channel was at capacity
//   - closed           : Enqueue called after Close
//   - nil_recorder     : Enqueue called on a nil Recorder
//   - shutdown_timeout : Close gave up draining before all events flushed
var recorderDroppedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "apikey_calls_recorder_dropped_total",
		Help: "RecorderMiddleware events not persisted, partitioned by reason.",
	},
	[]string{"reason"},
)

var recorderInsertTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "apikey_calls_recorder_insert_total",
		Help: "Worker-side INSERT outcomes for api_key_calls (ok|error).",
	},
	[]string{"outcome"},
)
