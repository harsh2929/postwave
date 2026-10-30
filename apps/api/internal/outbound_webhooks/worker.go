// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// AutoDisableNotifier sends one operator notification. It is consumed by the
// durable notification-outbox worker rather than the delivery worker, so a
// process crash after committing an auto-disable cannot lose the alert.
// Receiver URLs are deliberately not passed: path/query components can be
// credentials.
type AutoDisableNotifier interface {
	NotifyWebhookAutoDisabled(ctx context.Context, tenantID, webhookID string) error
}

// MetricsSink is an optional metrics emitter. We emit:
//
//   - outbound_webhook_exhausted_total{event_type}  — a delivery hit
//     MaxAttempts without a 2xx.
//   - outbound_webhook_lease_acquired_total — count of rows leased.
//
// main.go can wire this to the existing telemetry pkg; nil is a no-op.
type MetricsSink interface {
	IncExhausted(eventType string)
	IncLeaseAcquired(owner string, count int)
}

// Worker polls outbound_webhook_deliveries every PollInterval and
// delivers any pending rows whose next_attempt_at <= now(). Multiple
// replicas may run safely in parallel: AcquireLease uses SELECT FOR
// UPDATE SKIP LOCKED to ensure two replicas never grab the same row,
// and the (lease_owner, lease_expires_at) pair on each row lets a sibling
// worker steal back the lease if the original holder dies mid-delivery.
type Worker struct {
	Store        *Store
	HTTPClient   *http.Client
	Logger       *slog.Logger
	Metrics      MetricsSink
	PollInterval time.Duration
	ClaimBatch   int

	// Owner identifies this worker process in the lease columns. Set by
	// NewWorker to "<hostname>-<pid>"; tests inject a deterministic
	// value. Two replicas must never share an owner — the lease check
	// would let them both run a delivery in parallel.
	Owner string

	// LeaseDuration bounds how long a leased row stays "invisible" to
	// other workers before they may steal it back. Default 60s: long
	// enough that a healthy worker comfortably finishes a 10s HTTP call
	// + retries + DB write, short enough that an OOM-killed worker's
	// rows return to the pool inside a minute. Tune up if you regularly
	// see legitimate deliveries take longer than 60s.
	LeaseDuration time.Duration

	// Concurrency caps how many in-flight deliveries one Worker
	// processes simultaneously from a single batch. With leases each
	// row is safely held by this process, so parallel HTTP fan-out is
	// no longer a multi-replica hazard. Default 4 — small enough that
	// a runaway tenant can't saturate the outbound conn pool but big
	// enough to drain bursts faster than the previous strictly-
	// sequential dispatch.
	Concurrency int

	deliveries atomic.Int64
}

// DefaultPollInterval — the spec asks for 5s. Picked to feel "live"
// without hammering the DB; idle DB load is one tiny SELECT every 5s.
const DefaultPollInterval = 5 * time.Second

// DefaultClaimBatch caps how many deliveries one tick will fan out at
// once. 50 keeps a runaway tenant from monopolising the worker on a
// single tick — the next tick picks up the remainder.
const DefaultClaimBatch = 50

// DefaultLeaseDuration is the lease TTL used when the caller doesn't
// override it. 60s = ~6x the outbound HTTP timeout (10s) so a healthy
// delivery has comfortable slack before the lease expires; an
// OOM-killed worker's rows return to the queue within a minute.
const DefaultLeaseDuration = 60 * time.Second

// DefaultConcurrency is the in-batch parallelism level. 4 strikes a
// balance between draining bursts (sequential = 1 / batch / 10s per
// delivery = 5 / sec / replica) and keeping the outbound conn pool
// uncongested. Tune up via Worker.Concurrency for high-volume tenants.
const DefaultConcurrency = 4

// NewWorker constructs a Worker with sane defaults. The owner id is
// derived from hostname + pid — stable across a process's lifetime,
// distinct per replica, and round-trips through Postgres text without
// extra encoding (a uuid would also work but we lose human-readable
// lease ownership in psql, which ops uses to debug stuck rows).
func NewWorker(store *Store, logger *slog.Logger) *Worker {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown-host"
	}
	owner := fmt.Sprintf("%s-%d", host, os.Getpid())
	client := NewSecureHTTPClient(nil)
	if env := strings.ToLower(os.Getenv("POSTWAVE_ENV")); env == "dev" || env == "development" {
		client = HTTPClientRejectingRedirects(&http.Client{Timeout: 10 * time.Second})
	}
	return &Worker{
		Store:         store,
		HTTPClient:    client,
		Logger:        logger,
		PollInterval:  DefaultPollInterval,
		ClaimBatch:    DefaultClaimBatch,
		Owner:         owner,
		LeaseDuration: DefaultLeaseDuration,
		Concurrency:   DefaultConcurrency,
	}
}

// DeliveriesCount returns the worker's lifetime delivery attempt
// count. Used by tests + ops dashboards.
func (w *Worker) DeliveriesCount() int64 { return w.deliveries.Load() }

// Run blocks until ctx is cancelled, processing pending deliveries on
// each tick. Returns ctx.Err() on cancel.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return nil
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	interval := w.PollInterval
	if interval <= 0 {
		interval = DefaultPollInterval
	}
	timer := time.NewTimer(0) // fire immediately so a flood of pending rows doesn't wait the first tick
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			n, err := w.tick(ctx)
			if err != nil {
				logger.Warn("outbound_webhooks: tick failed", "err", err.Error())
			}
			next := interval
			if n > 0 {
				// Drain bursts at handler speed: if we got work this
				// tick, re-poll immediately so backed-up queues empty
				// quickly. Idle workers keep the steady-state cadence.
				next = 50 * time.Millisecond
			}
			timer.Reset(next)
		}
	}
}

// tick acquires one batch of leases and fans out deliveries (capped at
// Concurrency). Returns the number of deliveries attempted.
//
// Concurrency model: a fixed-size worker pool consumes a per-tick
// channel of leased rows. The tick blocks until every delivery in the
// batch has finalised (either MarkDelivered or MarkFailure ran, OR
// ReleaseLease cleared the row on a context cancel). That keeps the
// poll cadence honest — we never poll for more work while in-flight
// rows from this tick are still draining.
func (w *Worker) tick(ctx context.Context) (int, error) {
	limit := w.ClaimBatch
	if limit <= 0 {
		limit = DefaultClaimBatch
	}
	leaseDuration := w.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = DefaultLeaseDuration
	}
	owner := w.Owner
	if owner == "" {
		owner = "anon-worker"
	}
	pending, err := w.Store.AcquireLease(ctx, owner, limit, leaseDuration)
	if err != nil {
		return 0, err
	}
	if len(pending) == 0 {
		return 0, nil
	}
	if w.Metrics != nil {
		w.Metrics.IncLeaseAcquired(owner, len(pending))
	}
	concurrency := w.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	if concurrency > len(pending) {
		concurrency = len(pending)
	}
	jobs := make(chan PendingDelivery, len(pending))
	for _, p := range pending {
		jobs <- p
	}
	close(jobs)

	var wg sync.WaitGroup
	wg.Add(concurrency)
	for i := 0; i < concurrency; i++ {
		go func() {
			defer wg.Done()
			for p := range jobs {
				// If ctx is cancelled mid-batch we release the lease
				// so a sibling worker (or this worker on restart)
				// picks the row back up immediately — no waiting for
				// the lease to time out. ReleaseLease uses a fresh
				// context so the release survives the cancel.
				if ctx.Err() != nil {
					releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					if err := w.Store.ReleaseLease(releaseCtx, p.ID, owner); err != nil {
						w.logger().Warn("outbound_webhooks: release lease on cancel failed",
							"delivery", p.ID, "err", err.Error())
					}
					cancel()
					continue
				}
				w.safeDeliver(ctx, p)
			}
		}()
	}
	wg.Wait()
	return len(pending), nil
}

// logger returns a non-nil slog.Logger.
func (w *Worker) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *Worker) safeDeliver(ctx context.Context, p PendingDelivery) {
	defer func() {
		if r := recover(); r != nil {
			w.markDeliveryPanic(p, r)
		}
	}()
	w.deliver(ctx, p)
}

func (w *Worker) markDeliveryPanic(p PendingDelivery, recovered any) {
	logger := w.logger()
	panicText, _ := redactInspectablePlaygroundText(fmt.Sprint(recovered), nil)
	panicText = truncate(panicText, 512)
	failure := errors.New("worker panic")
	markCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	defer func() {
		if r := recover(); r != nil {
			recordingPanic, _ := redactInspectablePlaygroundText(fmt.Sprint(r), nil)
			logger.Error("outbound_webhooks: panic while recording delivery panic",
				"delivery", p.ID,
				"tenant", p.TenantID,
				"webhook", p.WebhookID,
				"panic", truncate(recordingPanic, 256))
		}
	}()

	status, _, err := w.Store.MarkFailure(markCtx, p, 0, "", failure, false)
	if err != nil {
		logger.Error("outbound_webhooks: record delivery panic failed",
			"delivery", p.ID,
			"tenant", p.TenantID,
			"webhook", p.WebhookID,
			"err", err.Error(),
			"panic", panicText)
		return
	}
	if status == "exhausted" && w.Metrics != nil {
		w.Metrics.IncExhausted(p.EventType)
	}
	logger.Error("outbound_webhooks: delivery panic recovered",
		"delivery", p.ID,
		"tenant", p.TenantID,
		"webhook", p.WebhookID,
		"status", status,
		"panic", panicText)
}

// deliver signs + POSTs one delivery and records the outcome. Always
// finishes a row (delivered, exhausted, or rescheduled) so the
// next_attempt_at index never has stale entries. The lease columns are
// implicitly cleared by MarkDelivered / MarkFailure.
func (w *Worker) deliver(ctx context.Context, p PendingDelivery) {
	w.deliveries.Add(1)
	logger := w.logger()
	destination, err := w.Store.ResolveDestination(ctx, p.TenantID, p.WebhookID)
	if err != nil {
		permanent := errors.Is(err, ErrDestinationInvalid)
		_, _, markErr := w.Store.MarkFailure(
			ctx,
			p,
			0,
			"",
			errors.New("delivery destination unavailable"),
			permanent,
		)
		if markErr != nil {
			logger.Warn("outbound_webhooks: mark destination failure failed",
				"tenant", p.TenantID,
				"webhook", p.WebhookID,
				"err", markErr.Error())
		}
		return
	}
	p.URL = destination
	// Lookup signing keys (primary + optional secondary during rotation).
	// If the row was deleted between claim and now, finalise as
	// exhausted — no point retrying.
	keys, err := w.Store.LoadSigningKeys(ctx, p.TenantID, p.WebhookID, time.Now().UTC())
	if err != nil {
		_, _, mErr := w.Store.MarkFailure(ctx, p, 0, "", fmt.Errorf("signing keys: %w", err), true)
		if mErr != nil {
			logger.Warn("outbound_webhooks: mark failure failed", "err", mErr.Error())
		}
		return
	}
	// Final envelope: dispatcher stored {event:{...}}; we add
	// webhook + delivery so customers can correlate.
	var envelope map[string]any
	if err := json.Unmarshal(p.Payload, &envelope); err != nil {
		_, _, _ = w.Store.MarkFailure(ctx, p, 0, "", fmt.Errorf("payload decode: %w", err), true)
		return
	}
	envelope["webhook"] = map[string]any{"id": p.WebhookID}
	envelope["delivery"] = map[string]any{
		"id":      p.ID,
		"attempt": p.AttemptCount + 1,
	}

	// Load filter + transform. Filter "no match" finalises the row as
	// `delivered` (it's the correct semantic: we successfully decided
	// this subscriber doesn't want this event). Transform reshapes the
	// payload BEFORE signing so the signature is over the transformed
	// body the receiver will see.
	cfg, cfgErr := w.Store.LoadDeliveryConfig(ctx, p.TenantID, p.WebhookID)
	if cfgErr != nil || cfg == nil {
		// Delivery configuration includes receiver authentication as well as
		// filter/transform policy. Proceeding with an empty config after a read
		// failure would send an unsigned-by-auth, unfiltered raw payload. Retry
		// the row with a stable, non-sensitive operator message instead.
		failure := errors.New("delivery configuration unavailable")
		permanent := errors.Is(cfgErr, ErrNotFound) ||
			errors.Is(cfgErr, ErrAuthConfigInvalid) ||
			errors.Is(cfgErr, ErrInvalidFilter) ||
			errors.Is(cfgErr, ErrInvalidTransform)
		_, _, markErr := w.Store.MarkFailure(ctx, p, 0, "", failure, permanent)
		if markErr != nil {
			logger.Warn("outbound_webhooks: mark configuration failure failed", "err", markErr.Error())
		}
		logger.Warn("outbound_webhooks: delivery configuration unavailable",
			"tenant", p.TenantID, "webhook", p.WebhookID, "err", cfgErr)
		return
	}
	prepared, err := prepareDelivery(cfg, envelope)
	if err != nil {
		_, _, _ = w.Store.MarkFailure(ctx, p, 0, "", fmt.Errorf("prepare payload: %w", err), true)
		return
	}
	if prepared.Filtered {
		// Skip-but-record: the delivery row gets a synthetic 204
		// so the operator dashboard can show "filtered out".
		if err := w.Store.MarkDelivered(ctx, p, 204, ""); err != nil {
			logger.Warn("outbound_webhooks: mark delivered (filtered) failed", "err", err.Error())
		}
		return
	}
	body := prepared.Body
	now := time.Now().UTC()
	signed, err := signWithKeys(keys, now, body)
	if err != nil {
		_, _, _ = w.Store.MarkFailure(ctx, p, 0, "", fmt.Errorf("sign: %w", err), true)
		return
	}
	authConfig := cfg.AuthConfig
	statusCode, respBody, postErr := w.post(
		ctx,
		p.URL,
		signed.Signature,
		signed.KeyIDs,
		p.EventType,
		p.SourceEventID,
		p.ID,
		body,
		authConfig,
	)
	// Receiver responses and transport errors are untrusted and may echo the
	// configured bearer token, custom auth headers, URL credentials, or another
	// credential-shaped value. Sanitize before persistence so delivery history,
	// health aggregates, logs and screenshots never become a secret store.
	safeRespBody, _ := redactInspectablePlaygroundResponseText(respBody, authConfig, p.URL)
	if postErr == nil && statusCode >= 200 && statusCode < 300 {
		if err := w.Store.MarkDelivered(ctx, p, statusCode, safeRespBody); err != nil {
			logger.Warn("outbound_webhooks: mark delivered failed", "err", err.Error())
		}
		return
	}
	skipRetry := permanentFailureStatus(statusCode)
	failure := postErr
	if failure == nil {
		failure = fmt.Errorf("http %d", statusCode)
	}
	safeFailure, _ := redactInspectablePlaygroundText(failure.Error(), authConfig)
	safeFailure, _ = redactPlaygroundDestinationText(safeFailure, p.URL)
	status, autoDisabled, err := w.Store.MarkFailure(ctx, p, statusCode, safeRespBody, errors.New(safeFailure), skipRetry)
	if err != nil {
		logger.Warn("outbound_webhooks: mark failure failed", "err", err.Error())
		return
	}
	if status == "exhausted" && w.Metrics != nil {
		w.Metrics.IncExhausted(p.EventType)
	}
	logger.Debug("outbound_webhooks: delivery failed",
		"tenant", p.TenantID, "webhook", p.WebhookID,
		"status", statusCode, "err", safeFailure,
		"final_status", status, "auto_disabled", autoDisabled)
}

// Redirects are intentionally never followed because receiver credentials and
// mTLS identity belong only to the configured origin. Treat a 3xx as a
// permanent endpoint-configuration failure instead of retrying it repeatedly.
// Other 4xx responses are permanent except the explicitly retryable 429.
func permanentFailureStatus(statusCode int) bool {
	return (statusCode >= 300 && statusCode < 400) ||
		(statusCode >= 400 && statusCode < 500 && statusCode != http.StatusTooManyRequests)
}

// post issues the signed HTTP POST. Returns the upstream status code,
// truncated body, and any transport error.
func (w *Worker) post(ctx context.Context, url, sig, keyIDs, eventType, eventID, deliveryID string, body []byte, authConfig *AuthConfig) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Moosewave-Webhooks/1.0")
	req.Header.Set(SignatureHeader, sig)
	if keyIDs != "" {
		req.Header.Set(KeyIDHeader, keyIDs)
	}
	req.Header.Set(EventHeader, eventType)
	if eventID != "" {
		req.Header.Set(EventIDHeader, eventID)
	}
	req.Header.Set(DeliveryHeader, deliveryID)
	applyAuthConfig(req, authConfig)
	client := w.HTTPClient
	if client == nil {
		client = NewSecureHTTPClient(nil)
	}
	client = HTTPClientRejectingRedirects(client)
	if authConfig != nil && authConfig.MTLSCertPEM != "" {
		client, err = clientWithAuth(client, authConfig)
		if err != nil {
			return 0, "", err
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBodyBytes+1))
	if readErr != nil || len(respBody) > MaxResponseBodyBytes {
		// Never persist a partial receiver preview: the omitted suffix can be
		// what proves a boundary-straddling token is sensitive. Receiving valid
		// 2xx headers still proves delivery, so withholding diagnostics must not
		// manufacture a retry of an already-committed receiver side effect.
		respBody = nil
	}
	if resp.StatusCode < 100 || resp.StatusCode > 599 {
		return 0, string(respBody), fmt.Errorf(
			"receiver returned unsupported HTTP status %d", resp.StatusCode,
		)
	}
	return resp.StatusCode, string(respBody), nil
}
