// SPDX-License-Identifier: AGPL-3.0-only
//
// Stripe webhook retry worker. Pairs with store.go's PgStore: every
// Interval (default 30s) the worker pulls up to BatchSize pending rows
// whose next_attempt_at is <= now, re-runs the inline handler against
// each stored payload, and either marks the attempt succeeded, schedules
// the next retry, or dead-letters when retries are exhausted.
package webhook_retry

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// signStripe mints a Stripe-Signature header for a replayed webhook
// payload. Same format the live handler verifies via
// billing.VerifySignature: "t=<unix>,v1=<hex hmac-sha256>" over
// "<unix>.<body>".
func signStripe(secret string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + strconv.FormatInt(ts, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Handler is the narrow contract the worker needs to re-run an event.
// In production this is wired to the existing
// billing.WebhookHandler.ServeHTTP — the worker fabricates a request
// with the original payload + a freshly-signed Stripe-Signature header.
//
// We deliberately re-use the existing http.Handler rather than
// extracting a parallel pure-Go dispatch path: the inline handler does
// signature verification, idempotency claim, and dispatch all in one
// place; we want one source of truth.
type Handler interface {
	ServeHTTP(w http.ResponseWriter, r *http.Request)
}

// Mailer is the narrow surface the worker needs to fire the dead-letter
// alert. nil disables the alert (logged-only).
type Mailer interface {
	SendDeadLetterAlert(ctx context.Context, to string, attempt Attempt) error
}

// Worker is the goroutine that drains the retry queue.
type Worker struct {
	Store      Store
	Handler    Handler
	Interval   time.Duration
	BatchSize  int
	AlertEmail string
	Mailer     Mailer
	Logger     *slog.Logger
	// SignerSecret is the Stripe webhook secret used to mint a fresh
	// signature for the replayed request. Same value as the env var
	// the live handler verifies against; we sign new requests so the
	// inline handler's signature check passes.
	SignerSecret string

	mu sync.Mutex
}

// Validate rejects the half-configured alerting case. An AlertEmail with no
// Mailer silently disables the dead-letter alert, which is how every
// dead-lettered Stripe event went unreported in production for months.
func (w *Worker) Validate() error {
	if w.AlertEmail != "" && w.Mailer == nil {
		return errors.New("webhook_retry: AlertEmail is set but Mailer is nil; the dead-letter alert would never fire")
	}
	return nil
}

// stripeWebhookDeadLetteredTotal mirrors the spec contract:
//
//	stripe_webhook_dead_lettered_total{event_type="..."}
var stripeWebhookDeadLetteredTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "stripe_webhook_dead_lettered_total",
	Help: "Stripe webhook events the retry worker gave up on after MaxAttempts retries.",
}, []string{"event_type"})

// stripeWebhookRetryAttemptsTotal tracks worker attempts overall.
var stripeWebhookRetryAttemptsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "stripe_webhook_retry_attempts_total",
	Help: "Stripe webhook retry-worker attempts by outcome.",
}, []string{"outcome"})

// NewWorker constructs a Worker with sensible defaults.
func NewWorker(store Store, handler Handler) *Worker {
	return &Worker{
		Store:     store,
		Handler:   handler,
		Interval:  30 * time.Second,
		BatchSize: 20,
	}
}

// Run blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Store == nil {
		return
	}
	t := time.NewTicker(w.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.RunOnce(ctx)
		}
	}
}

func (w *Worker) interval() time.Duration {
	if w.Interval > 0 {
		return w.Interval
	}
	return 30 * time.Second
}

func (w *Worker) batchSize() int {
	if w.BatchSize > 0 {
		return w.BatchSize
	}
	return 20
}

// RunOnce drains one batch. Exposed so tests can step the worker
// deterministically.
func (w *Worker) RunOnce(ctx context.Context) {
	if w == nil || w.Store == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil && w != nil && w.Logger != nil {
			w.Logger.Error("retry worker RunOnce panic recovered", "panic", fmt.Sprint(rec))
		}
	}()
	w.mu.Lock()
	defer w.mu.Unlock()
	due, err := w.Store.DequeueDue(ctx, w.batchSize())
	if err != nil {
		if w.Logger != nil {
			w.Logger.Warn("retry worker dequeue failed", "err", err.Error())
		}
		return
	}
	for _, a := range due {
		if ctx.Err() != nil {
			return
		}
		w.safeProcess(ctx, a)
	}
}

func (w *Worker) safeProcess(ctx context.Context, a Attempt) {
	defer func() {
		if rec := recover(); rec != nil && w.Logger != nil {
			w.Logger.Error("retry worker attempt panic recovered",
				"attempt_id", a.ID,
				"event_id", a.EventID,
				"panic", fmt.Sprint(rec))
		}
	}()
	w.process(ctx, a)
}

// process runs a single attempt through the handler and updates the
// store accordingly. Errors at every step are logged; this loop never
// returns one because we don't want a single bad row to stall the
// queue.
func (w *Worker) process(ctx context.Context, a Attempt) {
	err := w.invokeHandler(ctx, a)
	if err == nil {
		if mErr := w.Store.MarkSucceeded(ctx, a.ID); mErr != nil && w.Logger != nil {
			w.Logger.Warn("retry worker mark succeeded failed",
				"attempt_id", a.ID, "event_id", a.EventID, "err", mErr.Error())
		}
		stripeWebhookRetryAttemptsTotal.WithLabelValues("succeeded").Inc()
		return
	}
	mErr := w.Store.MarkFailed(ctx, a.ID, err)
	if mErr == nil {
		stripeWebhookRetryAttemptsTotal.WithLabelValues("failed").Inc()
		if w.Logger != nil {
			w.Logger.Info("retry worker scheduled next attempt",
				"attempt_id", a.ID,
				"event_id", a.EventID,
				"attempt_number", a.AttemptNumber,
				"err", err.Error())
		}
		return
	}
	if IsExhausted(mErr) {
		w.deadLetter(ctx, a, err)
		return
	}
	if w.Logger != nil {
		w.Logger.Warn("retry worker mark failed errored",
			"attempt_id", a.ID, "err", mErr.Error())
	}
}

// invokeHandler synthesises an *http.Request that mirrors the original
// Stripe POST and runs it through the bound handler. Returns nil on
// 2xx, an error otherwise.
func (w *Worker) invokeHandler(ctx context.Context, a Attempt) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("handler panic: %v", rec)
		}
	}()
	if w.Handler == nil {
		return errors.New("no handler wired")
	}
	body := a.PayloadJSON
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://retry-worker/api/public/stripe/webhook", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if w.SignerSecret != "" {
		ts := time.Now().Unix()
		req.Header.Set("Stripe-Signature", signStripe(w.SignerSecret, ts, body))
	}
	rec := httptest.NewRecorder()
	w.Handler.ServeHTTP(rec, req)
	if rec.Code >= 200 && rec.Code < 300 {
		return nil
	}
	return fmt.Errorf("handler returned %d: %s", rec.Code,
		strings.TrimSpace(rec.Body.String()))
}

// deadLetter persists the dead-letter transition + emits side effects:
// metric increment, structured log, optional alert email.
func (w *Worker) deadLetter(ctx context.Context, a Attempt, finalErr error) {
	if dErr := w.Store.DeadLetter(ctx, a.ID, finalErr); dErr != nil && w.Logger != nil {
		w.Logger.Warn("retry worker dead-letter persist failed",
			"attempt_id", a.ID, "err", dErr.Error())
	}
	stripeWebhookRetryAttemptsTotal.WithLabelValues("dead_lettered").Inc()
	stripeWebhookDeadLetteredTotal.WithLabelValues(eventTypeOf(a.PayloadJSON)).Inc()
	if w.Logger != nil {
		w.Logger.Error("stripe webhook dead-lettered after exhausting retries",
			"attempt_id", a.ID,
			"event_id", a.EventID,
			"final_err", finalErr.Error())
	}
	if w.Mailer != nil && w.AlertEmail != "" {
		go func() {
			defer func() {
				if rec := recover(); rec != nil && w.Logger != nil {
					w.Logger.Error("dead-letter alert email panic recovered",
						"attempt_id", a.ID,
						"panic", fmt.Sprint(rec))
				}
			}()
			ac, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := w.Mailer.SendDeadLetterAlert(ac, w.AlertEmail, a); err != nil && w.Logger != nil {
				w.Logger.Warn("dead-letter alert email failed",
					"attempt_id", a.ID, "err", err.Error())
			}
		}()
	}
}

// eventTypeOf peeks at the JSON payload for the "type" field so we can
// label the dead-letter metric.
func eventTypeOf(payload []byte) string {
	if len(payload) == 0 {
		return "unknown"
	}
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &probe); err != nil || probe.Type == "" {
		return "unknown"
	}
	return probe.Type
}
