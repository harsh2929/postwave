// Recurrence-scanner observability — Prometheus instrumentation for
// RecurrenceScanner. Exposed metrics:
//
//   - postwave_recurrence_scanner_runs_total{result}     — counter,
//                                                          result ∈ {ok, error}
//   - postwave_recurrence_scanner_last_run_timestamp     — gauge, unix seconds
//   - postwave_recurrence_scanner_processed_total        — counter, child
//                                                          campaigns spawned
//
// Scope: instruments RecurrenceScanner.Trigger (admin "run now") and
// RecurrenceScanner.tick (the nightly ticker). Both call paths funnel
// through the same observe helpers so a Grafana panel can plot either
// without distinguishing source.
//
// Cardinality: no per-tenant labels — the scanner is cross-tenant by
// design (privileged role, RLS bypassed) and a label per tenant would
// blow up cardinality on a multi-thousand-tenant cluster. The "result"
// label is a closed two-value set {ok, error}, safe.
//
// Like apps/api/internal/sending/metrics.go, registration happens at
// package-init via promauto on the global default registry. The
// automation service's main.go must add a /metrics endpoint that
// promhttp.Handler() serves; see services/automation/main.go.

package worker

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	recurrenceRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_recurrence_scanner_runs_total",
		Help: "Total RecurrenceScanner runs, partitioned by terminal result (ok|error).",
	}, []string{"result"})

	recurrenceLastRun = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "postwave_recurrence_scanner_last_run_timestamp",
		Help: "Unix timestamp (seconds) of the last RecurrenceScanner run, regardless of result.",
	})

	recurrenceProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_recurrence_scanner_processed_total",
		Help: "Total child campaigns spawned by the recurrence scanner.",
	})

	automationExecutions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_automation_task_executions_total",
		Help: "Automation execute task outcomes.",
	}, []string{"result"})

	automationRetryDelay = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "postwave_automation_retry_delay_seconds",
		Help:    "Retry delay chosen for transient automation task failures.",
		Buckets: []float64{5, 15, 30, 60, 120, 300, 600, 1800, 3600},
	})

	automationQueueDepth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "postwave_automation_queue_depth",
		Help: "Pending, scheduled, and retry automation tasks reported by the production queue.",
	}, []string{"queue"})

	automationQueueObservationFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_automation_queue_observation_failures_total",
		Help: "Failed attempts to read automation queue depth.",
	}, []string{"queue"})
)

type queueDepthReader interface {
	Depth(context.Context) (int, error)
}

// RunQueueMetrics samples the production queue independently of health-check
// traffic. A failed Redis/Asynq inspection increments a separate counter and
// leaves the last good depth intact, so a transient read error cannot falsely
// report an empty queue. The label is operator-controlled and has one value per
// service instance.
func RunQueueMetrics(ctx context.Context, queue queueDepthReader, queueName string, interval time.Duration) {
	if ctx == nil || queue == nil {
		return
	}
	if queueName == "" {
		queueName = "automation_default"
	}
	if interval <= 0 {
		interval = 15 * time.Second
	}

	observe := func() {
		timeout := 5 * time.Second
		if interval < timeout {
			timeout = interval
		}
		observationCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		depth, err := queue.Depth(observationCtx)
		if err != nil {
			automationQueueObservationFailures.WithLabelValues(queueName).Inc()
			return
		}
		automationQueueDepth.WithLabelValues(queueName).Set(float64(depth))
	}

	observe()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			observe()
		}
	}
}

// SmokeObserveRun is an exported wrapper for cmd/metrics-smoke that
// lets the smoke binary force a CounterVec sample so /metrics emits the
// family. Not used at runtime.
func SmokeObserveRun(processed int, err error) { observeRecurrenceRun(processed, err) }

// observeRecurrenceRun records the outcome of a single scanner run.
// processed is the number of child campaigns spawned during the run
// (always added to the processed counter, even on error — the scanner
// is best-effort and may spawn N children before erroring on N+1).
func observeRecurrenceRun(processed int, runErr error) {
	recurrenceLastRun.Set(float64(time.Now().Unix()))
	if processed > 0 {
		recurrenceProcessed.Add(float64(processed))
	}
	if runErr != nil {
		recurrenceRuns.WithLabelValues("error").Inc()
		return
	}
	recurrenceRuns.WithLabelValues("ok").Inc()
}

func observeAutomationTask(result string) {
	automationExecutions.WithLabelValues(result).Inc()
}

func observeAutomationRetryDelay(d time.Duration) {
	automationRetryDelay.Observe(d.Seconds())
}
