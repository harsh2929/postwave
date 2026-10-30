// SPDX-License-Identifier: AGPL-3.0-only
//
// view_recorder.go — async, retry-aware buffer between the tracking
// pixel handler and the archive_views INSERT.
//
// Why this exists:
//   The pre-fix PublicViewPixel did
//       _ = d.Repo.RecordView(r.Context(), ...)
//   inline + dropped the error. A single transient DB hiccup
//   (connection storm, transaction wraparound vacuum, hot row lock)
//   silently swallowed the view. Combined with the per-visitor
//   rate-limiter — which already deduplicates aggressively — recorded
//   counts materially underestimated real traffic.
//
// Design (inspired by Ghost's `MemberEvents` queue + Mailchimp's
// pixel sink): the handler enqueues a small struct into a bounded
// buffered channel, then returns the GIF immediately. A pool of
// background workers drains the channel and INSERTs with exponential
// backoff. The handler-side path is allocation-cheap and never blocks
// on the DB; the worker absorbs latency / transient failure on behalf
// of the visitor.
//
// Observability surface:
//   - archive_view_enqueued_total{outcome=queued|dropped}
//   - archive_view_record_total{outcome=ok|error}
//   - archive_view_record_attempts (histogram-like — see notes)
//
// Backpressure semantics:
//   - Channel is bounded (capacity = ViewRecorderBufferSize).
//   - A full channel is treated as a "shed" — we DROP the new event
//     and increment archive_view_dropped_total{reason=buffer_full}
//     rather than block the HTTP handler. This is the right call for
//     a tracking pixel: latency on the visitor's page is unacceptable,
//     and dropping a single view during a DB-induced backlog is
//     materially better than dropping the visitor's request.
//   - On shutdown the Close() method drains the buffer with a bounded
//     deadline so in-flight events complete instead of vanishing on
//     SIGTERM.

package archive

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Tunables. Exported (var, not const) so tests / specialised callers
// can pin smaller values; defaults are sized for a single mid-traffic
// archive (≈ a few hundred views/min) with a 10× burst headroom.
var (
	// ViewRecorderBufferSize is the channel capacity. At ~5 ms per
	// INSERT and 4 workers ≈ 800 events/s of sustained throughput;
	// the buffer just absorbs bursts up to ~12 s of full-pipe traffic.
	ViewRecorderBufferSize = 4096

	// ViewRecorderWorkers is the number of concurrent drain workers.
	// 4 keeps connection-pool pressure low while giving us 4× the
	// throughput of the synchronous baseline.
	ViewRecorderWorkers = 4

	// ViewRecorderMaxAttempts caps INSERT retries before a single
	// event is permanently dropped. 3 attempts × ~200 ms ≈ 600 ms of
	// retry budget per event, well under any reasonable DB outage.
	ViewRecorderMaxAttempts = 3

	// ViewRecorderBaseBackoff is the first-retry sleep. Doubles each
	// subsequent attempt with ±25 % jitter. The first attempt has no
	// pre-sleep.
	ViewRecorderBaseBackoff = 50 * time.Millisecond

	// ViewRecorderMaxBackoff caps individual backoff sleeps so a tight
	// outage doesn't stall the worker for minutes.
	ViewRecorderMaxBackoff = 2 * time.Second

	// ViewRecorderInsertTimeout is the per-attempt DB call deadline.
	// Generous so a slow-but-recovering connection doesn't get killed,
	// but tight enough that a wedged tx doesn't pin a worker forever.
	ViewRecorderInsertTimeout = 5 * time.Second

	// ViewRecorderShutdownTimeout is how long Close() waits for the
	// buffer + in-flight events to drain. Sized so a normal SIGTERM
	// in production (≈30 s grace) still has slack for the rest of
	// graceful shutdown.
	ViewRecorderShutdownTimeout = 10 * time.Second
)

// viewEvent is the in-memory representation of a pending INSERT.
// Kept narrow + value-typed so enqueue is a single channel send and
// the buffer's working-set is predictable.
type viewEvent struct {
	tenantID   string
	campaignID string
	visitorID  string
	referrer   string
	country    string
	bot        bool
}

// viewRecordSink is the storage hook the recorder calls. Defined as an
// interface so tests can substitute a deterministic stub without
// standing up the full Pool. In production this is *Repo.
type viewRecordSink interface {
	RecordView(ctx context.Context, tenantID, campaignID, visitorID, referrer, country string, bot bool) error
}

// ViewRecorder is the async write-behind buffer that backs
// PublicViewPixel. Zero value is NOT usable — call NewViewRecorder.
type ViewRecorder struct {
	sink   viewRecordSink
	ch     chan viewEvent
	wg     sync.WaitGroup
	stopCh chan struct{}
	closed atomic_bool
	logger *slog.Logger
}

// atomic_bool is a tiny shim so we don't pull in sync/atomic.Bool's
// constraints on go versions and to keep the rest of the code
// straightforward. Internally a mutex-guarded bool is fine here — the
// hot path (enqueue / drain) doesn't touch this field.
type atomic_bool struct {
	mu sync.Mutex
	v  bool
}

func (b *atomic_bool) set() {
	b.mu.Lock()
	b.v = true
	b.mu.Unlock()
}

func (b *atomic_bool) load() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.v
}

// NewViewRecorder constructs a ViewRecorder and starts its worker
// goroutines. Callers should invoke Close() during graceful shutdown
// to drain in-flight events.
//
// `logger` may be nil; we fall back to slog.Default() so production
// wiring isn't forced to thread a logger through Deps.
func NewViewRecorder(sink viewRecordSink, logger *slog.Logger) *ViewRecorder {
	// Allow env override (handy for ops to crank up the buffer without
	// a redeploy when a content-virality spike is observed).
	if v := os.Getenv("ARCHIVE_VIEW_BUFFER_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			ViewRecorderBufferSize = n
		}
	}
	if v := os.Getenv("ARCHIVE_VIEW_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			ViewRecorderWorkers = n
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	r := &ViewRecorder{
		sink:   sink,
		ch:     make(chan viewEvent, ViewRecorderBufferSize),
		stopCh: make(chan struct{}),
		logger: logger,
	}
	for i := 0; i < ViewRecorderWorkers; i++ {
		r.wg.Add(1)
		go r.workerLoop()
	}
	return r
}

// Enqueue is the non-blocking handler-side entry point. Returns true
// when the event was buffered, false when dropped (buffer full OR
// recorder closed). Callers SHOULD NOT log on `false` — the
// archive_view_dropped_total counter is the canonical signal.
//
// Hot path: one channel send. No allocations, no DB I/O, no log.
func (r *ViewRecorder) Enqueue(tenantID, campaignID, visitorID, referrer, country string, bot bool) bool {
	if r == nil {
		// Defensive: a nil recorder is treated as "no observation",
		// not a panic. The PublicViewPixel path is best-effort and
		// must never crash the request handler.
		archiveViewEnqueuedTotal.WithLabelValues("dropped_nil").Inc()
		return false
	}
	if r.closed.load() {
		archiveViewEnqueuedTotal.WithLabelValues("dropped_closed").Inc()
		return false
	}
	ev := viewEvent{
		tenantID:   tenantID,
		campaignID: campaignID,
		visitorID:  visitorID,
		referrer:   referrer,
		country:    country,
		bot:        bot,
	}
	select {
	case r.ch <- ev:
		archiveViewEnqueuedTotal.WithLabelValues("queued").Inc()
		return true
	default:
		// Buffer full — shed the event rather than block the handler.
		// archive_view_dropped_total is the SLO-visible signal that
		// ops uses to decide whether to bump ARCHIVE_VIEW_BUFFER_SIZE
		// or scale workers.
		archiveViewEnqueuedTotal.WithLabelValues("dropped_buffer_full").Inc()
		archiveViewDroppedTotal.WithLabelValues("buffer_full").Inc()
		return false
	}
}

// QueueDepth returns the current number of buffered events. Useful for
// /metrics-adjacent debug endpoints and tests. Read-only — no lock
// because len(ch) is atomic for a buffered channel.
func (r *ViewRecorder) QueueDepth() int {
	if r == nil {
		return 0
	}
	return len(r.ch)
}

// Close stops accepting new events and waits for the workers to drain
// the buffer. Bounded by ViewRecorderShutdownTimeout so a misbehaving
// DB doesn't hang the entire process shutdown.
func (r *ViewRecorder) Close() {
	if r == nil {
		return
	}
	r.closed.set()
	// Closing the channel signals workers to drain the remaining
	// buffer and exit when ch is empty. Subsequent Enqueue calls
	// return false via the `closed` flag — they never reach the
	// `r.ch <- ev` send on a closed channel, which would panic.
	close(r.ch)
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(ViewRecorderShutdownTimeout):
		// Workers are still draining; we accept losing the tail to
		// keep graceful shutdown bounded. The dropped count below
		// gives ops visibility into the worst case.
		remaining := len(r.ch)
		if remaining > 0 {
			r.logger.Warn("archive: view recorder shutdown timeout, dropped tail",
				slog.Int("remaining", remaining))
			archiveViewDroppedTotal.WithLabelValues("shutdown_timeout").Add(float64(remaining))
		}
	}
}

// workerLoop drains the buffered channel, applying retry on transient
// errors. Exits when the channel is closed AND drained.
func (r *ViewRecorder) workerLoop() {
	defer r.wg.Done()
	for ev := range r.ch {
		r.processOne(ev)
	}
}

// processOne handles a single event with retry. Total attempt budget
// is ViewRecorderMaxAttempts; we treat any non-nil error as
// retry-able (the underlying pgx errors don't always classify cleanly
// without driver-specific introspection — we'd rather over-retry a
// permanent error than silently lose a transient one). The
// per-attempt timeout protects us from a wedged transaction.
func (r *ViewRecorder) processOne(ev viewEvent) {
	var lastErr error
	for attempt := 1; attempt <= ViewRecorderMaxAttempts; attempt++ {
		if attempt > 1 {
			time.Sleep(backoffFor(attempt))
		}
		ctx, cancel := context.WithTimeout(context.Background(), ViewRecorderInsertTimeout)
		err := r.sink.RecordView(ctx, ev.tenantID, ev.campaignID, ev.visitorID, ev.referrer, ev.country, ev.bot)
		cancel()
		if err == nil {
			archiveViewRecordTotal.WithLabelValues("ok").Inc()
			archiveViewRecordAttempts.WithLabelValues("ok").Observe(float64(attempt))
			return
		}
		lastErr = err
		// Don't waste retries on context-canceled shutdown signals —
		// the worker is exiting; log and bail.
		if errors.Is(err, context.Canceled) {
			break
		}
	}
	archiveViewRecordTotal.WithLabelValues("error").Inc()
	archiveViewRecordAttempts.WithLabelValues("error").Observe(float64(ViewRecorderMaxAttempts))
	archiveViewDroppedTotal.WithLabelValues("retries_exhausted").Inc()
	if r.logger != nil {
		r.logger.Warn("archive: view record failed after retries",
			slog.String("tenant_id", ev.tenantID),
			slog.String("campaign_id", ev.campaignID),
			slog.Int("attempts", ViewRecorderMaxAttempts),
			slog.Any("err", lastErr))
	}
}

// backoffFor returns the pre-attempt sleep duration. attempt is
// 1-based; attempt=1 should not call this (we short-circuit in
// processOne) — but if it does, returns 0.
func backoffFor(attempt int) time.Duration {
	if attempt <= 1 {
		return 0
	}
	d := ViewRecorderBaseBackoff << (attempt - 2)
	if d <= 0 || d > ViewRecorderMaxBackoff {
		d = ViewRecorderMaxBackoff
	}
	// ±25 % jitter to prevent thundering-herd on a DB recovery.
	jitter := time.Duration(rand.Int64N(int64(d/2))) - d/4
	out := d + jitter
	if out < 0 {
		out = d
	}
	return out
}

// ---------------------------------------------------------------------
// Prometheus surface
// ---------------------------------------------------------------------

var archiveViewEnqueuedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "archive_view_enqueued_total",
		Help: "Archive pixel view-recording enqueue attempts, partitioned by outcome (queued|dropped_buffer_full|dropped_closed|dropped_nil).",
	},
	[]string{"outcome"},
)

// archiveViewDroppedTotal is the dedicated SLO signal called out in
// the gap audit. Always emit a `reason` label so dashboards can split
// transient buffer-full incidents from "we genuinely couldn't persist
// after N retries".
var archiveViewDroppedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "archive_view_dropped_total",
		Help: "Archive pixel view events that were not persisted, partitioned by reason (buffer_full|retries_exhausted|shutdown_timeout).",
	},
	[]string{"reason"},
)

var archiveViewRecordTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "archive_view_record_total",
		Help: "Worker-side INSERT outcomes for archive_views (ok|error).",
	},
	[]string{"outcome"},
)

// archiveViewRecordAttempts is a Histogram of attempt counts so we can
// alert on "p99 attempts > 1" (i.e. retries becoming the norm).
// Buckets are small integers; 1..MaxAttempts is the entire interesting
// range.
var archiveViewRecordAttempts = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "archive_view_record_attempts",
		Help:    "Number of attempts before an archive_views INSERT succeeded or was finally dropped.",
		Buckets: []float64{1, 2, 3, 4, 5},
	},
	[]string{"outcome"},
)
