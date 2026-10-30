// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultActionWorkerInterval = time.Second
	defaultActionWorkerLease    = 5 * time.Minute
	defaultActionWorkerBatch    = 10
	maxActionWorkerTenants      = 100
	maxActionAttempts           = 24
	maxAutomationEventWireBytes = 64 << 10
)

var (
	inboundActionClaimedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inbound_webhook_action_claimed_total",
		Help: "Durable inbound webhook actions claimed for execution.",
	}, []string{"kind"})
	inboundActionCompletedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inbound_webhook_action_completed_total",
		Help: "Durable inbound webhook actions completed.",
	}, []string{"kind"})
	inboundActionRetryTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inbound_webhook_action_retry_total",
		Help: "Durable inbound webhook actions returned to the retry queue.",
	}, []string{"kind", "error_code"})
	inboundActionFailedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inbound_webhook_action_failed_total",
		Help: "Durable inbound webhook actions terminally rejected.",
	}, []string{"kind", "error_code"})
)

// DurableActionExecutor is the idempotency-aware extension used by the action
// worker. Implementations must make repeating the same actionID safe.
type DurableActionExecutor interface {
	ExecuteDurableAction(
		ctx context.Context,
		actionID, tenantID, actionType, targetID, email string,
	) error
}

// ActionWorker drains occurrence-time trigger snapshots and automation-event
// fanout intents. Claims are tenant-scoped and leased; a crash simply lets the
// lease expire. Repeated execution is safe because local mutations are
// idempotent and HTTP actions carry the stable intent UUID as Idempotency-Key.
type ActionWorker struct {
	Repo                 *Repo
	Executor             ActionExecutor
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	Logger               *slog.Logger
	MatchLogger          func(Match)
	Interval             time.Duration
	Lease                time.Duration
	BatchSize            int
	Now                  func() time.Time

	discoveryMu     sync.Mutex
	discoveryCursor string
}

type actionExecutionError struct {
	code       string
	httpStatus int
	permanent  bool
	err        error
}

func (e *actionExecutionError) Error() string {
	if e == nil || e.err == nil {
		return "inbound webhook action failed"
	}
	return e.err.Error()
}

func (e *actionExecutionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

func (w *ActionWorker) now() time.Time {
	if w != nil && w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *ActionWorker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *ActionWorker) interval() time.Duration {
	if w != nil && w.Interval > 0 {
		return w.Interval
	}
	return defaultActionWorkerInterval
}

func (w *ActionWorker) lease() time.Duration {
	if w != nil && w.Lease > 0 {
		return w.Lease
	}
	return defaultActionWorkerLease
}

func (w *ActionWorker) batchSize() int {
	if w != nil && w.BatchSize > 0 && w.BatchSize <= 100 {
		return w.BatchSize
	}
	return defaultActionWorkerBatch
}

// Run blocks until ctx cancellation and continuously retries transient work.
func (w *ActionWorker) Run(ctx context.Context) error {
	if w == nil || w.Repo == nil || w.Repo.Pool == nil {
		return errors.New("inbound_webhooks: action worker repository is unavailable")
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if _, err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				w.log().Warn("inbound webhook action worker tick failed",
					"error_code", classifyWorkerLoopError(err))
			}
			timer.Reset(w.interval())
		}
	}
}

// RunOnce discovers a bounded tenant set, claims a bounded batch per tenant,
// and executes each action. It is exported so lifecycle and DB tests can drive
// one deterministic tick without sleeping.
func (w *ActionWorker) RunOnce(ctx context.Context) (int, error) {
	tenantIDs, err := w.discoverDueTenants(ctx)
	if err != nil {
		return 0, err
	}
	processed := 0
	var failures []error
	for _, tenantID := range tenantIDs {
		if err := ctx.Err(); err != nil {
			return processed, err
		}
		actions, claimErr := w.claim(ctx, tenantID)
		if claimErr != nil {
			failures = append(failures, claimErr)
			continue
		}
		for i := range actions {
			action := actions[i]
			inboundActionClaimedTotal.WithLabelValues(action.IntentKind).Inc()
			execErr := w.execute(ctx, action)
			if execErr == nil {
				if completeErr := w.finish(ctx, action, ActionIntentSucceeded, "", 0); completeErr != nil {
					failures = append(failures, completeErr)
					continue
				}
				inboundActionCompletedTotal.WithLabelValues(action.IntentKind).Inc()
				w.logMatch(action, true, "")
				processed++
				continue
			}
			code, status, permanent := classifyActionError(execErr)
			if permanent {
				if finishErr := w.finish(ctx, action, ActionIntentFailed, code, status); finishErr != nil {
					failures = append(failures, finishErr)
					continue
				}
				inboundActionFailedTotal.WithLabelValues(action.IntentKind, code).Inc()
				w.logMatch(action, false, code)
				processed++
				continue
			}
			if shouldExhaustActionRetry(action.Attempts) {
				if finishErr := w.finish(
					ctx,
					action,
					ActionIntentFailed,
					"retry_exhausted",
					status,
				); finishErr != nil {
					failures = append(failures, finishErr)
					continue
				}
				inboundActionFailedTotal.WithLabelValues(
					action.IntentKind,
					"retry_exhausted",
				).Inc()
				w.logMatch(action, false, "retry_exhausted")
				processed++
				continue
			}
			next := w.now().Add(actionRetryDelay(action.Attempts))
			if retryErr := w.retry(ctx, action, code, status, next); retryErr != nil {
				failures = append(failures, retryErr)
				continue
			}
			inboundActionRetryTotal.WithLabelValues(action.IntentKind, code).Inc()
			processed++
		}
	}
	return processed, errors.Join(failures...)
}

func (w *ActionWorker) discoverDueTenants(ctx context.Context) ([]string, error) {
	w.discoveryMu.Lock()
	defer w.discoveryMu.Unlock()

	tx, err := db.WithWorkerScope(ctx, w.Repo.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH due_tenants AS (
    SELECT tenant_id::text AS tenant_id
      FROM inbound_webhook_action_intents
     WHERE (state = 'pending' AND next_attempt_at <= now())
        OR (state = 'leased' AND lease_expires_at <= now())
     GROUP BY tenant_id
)
SELECT tenant_id
  FROM due_tenants
 ORDER BY CASE WHEN tenant_id > $2 THEN 0 ELSE 1 END,
          tenant_id
 LIMIT $1`,
		maxActionWorkerTenants,
		w.discoveryCursor,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tenantIDs []string
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, err
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(tenantIDs) > 0 {
		w.discoveryCursor = tenantIDs[len(tenantIDs)-1]
	}
	return tenantIDs, nil
}

func (w *ActionWorker) claim(ctx context.Context, tenantID string) ([]ActionIntent, error) {
	tx, err := db.WithTenant(ctx, w.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	leaseToken := uuid.NewString()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM inbound_webhook_action_intents
     WHERE tenant_id = $1::uuid
       AND (
           (state = 'pending' AND next_attempt_at <= now())
           OR (state = 'leased' AND lease_expires_at <= now())
       )
     ORDER BY next_attempt_at, created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $2
)
UPDATE inbound_webhook_action_intents AS action
   SET state = 'leased',
       attempts = action.attempts + 1,
       lease_token = $3::uuid,
       lease_expires_at = now() + $4::interval,
       updated_at = now()
  FROM candidates
 WHERE action.id = candidates.id
RETURNING action.id::text,
          action.tenant_id::text,
          action.inbound_event_id,
          action.endpoint_id::text,
          action.replay_id::text,
          action.intent_kind,
          action.trigger_id::text,
          action.trigger_name,
          action.action_type,
          action.action_target_id,
          action.subscriber_email,
          action.attempts,
          action.lease_token::text,
          (SELECT event.body_bytes
             FROM inbound_events AS event
            WHERE event.id = action.inbound_event_id
              AND event.tenant_id = action.tenant_id),
          (SELECT event.received_at
             FROM inbound_events AS event
            WHERE event.id = action.inbound_event_id
              AND event.tenant_id = action.tenant_id)`,
		tenantID,
		w.batchSize(),
		leaseToken,
		fmt.Sprintf("%f seconds", w.lease().Seconds()),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	actions := make([]ActionIntent, 0, w.batchSize())
	for rows.Next() {
		var action ActionIntent
		var occurredAt time.Time
		if err := rows.Scan(
			&action.ID,
			&action.TenantID,
			&action.InboundEventID,
			&action.EndpointID,
			&action.ReplayID,
			&action.IntentKind,
			&action.TriggerID,
			&action.TriggerName,
			&action.ActionType,
			&action.ActionTargetID,
			&action.SubscriberEmail,
			&action.Attempts,
			&action.LeaseToken,
			&action.Body,
			&occurredAt,
		); err != nil {
			return nil, err
		}
		action.OccurredAt = occurredAt
		actions = append(actions, action)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return actions, nil
}

func (w *ActionWorker) execute(ctx context.Context, action ActionIntent) error {
	switch action.IntentKind {
	case ActionIntentAutomationEvent:
		return w.dispatchAutomationEvent(ctx, action)
	case ActionIntentTriggerAction:
		return w.executeTriggerAction(ctx, action)
	default:
		return &actionExecutionError{
			code:      "unknown_intent_kind",
			permanent: true,
			err:       errors.New("unknown inbound webhook action kind"),
		}
	}
}

func (w *ActionWorker) executeTriggerAction(ctx context.Context, action ActionIntent) error {
	if action.ActionType == nil || action.ActionTargetID == nil ||
		action.SubscriberEmail == nil {
		return &actionExecutionError{
			code:      "invalid_trigger_snapshot",
			permanent: true,
			err:       errors.New("invalid trigger action snapshot"),
		}
	}
	if durable, ok := w.Executor.(DurableActionExecutor); ok {
		return durable.ExecuteDurableAction(
			ctx,
			action.ID,
			action.TenantID,
			*action.ActionType,
			*action.ActionTargetID,
			*action.SubscriberEmail,
		)
	}
	if w.Executor == nil {
		return &actionExecutionError{
			code: "executor_unavailable",
			err:  errors.New("trigger action executor is unavailable"),
		}
	}
	var err error
	switch *action.ActionType {
	case ActionAddToSequence:
		err = w.Executor.AddToSequence(ctx, action.TenantID, *action.ActionTargetID, *action.SubscriberEmail)
	case ActionAddTag:
		err = w.Executor.AddTag(ctx, action.TenantID, *action.ActionTargetID, *action.SubscriberEmail)
	case ActionRemoveTag:
		err = w.Executor.RemoveTag(ctx, action.TenantID, *action.ActionTargetID, *action.SubscriberEmail)
	case ActionStartAutomation:
		return &actionExecutionError{
			code: "durable_executor_unavailable",
			err:  errors.New("idempotent automation executor is unavailable"),
		}
	default:
		return &actionExecutionError{
			code:      "unknown_action_type",
			permanent: true,
			err:       errors.New("unknown trigger action type"),
		}
	}
	return err
}

func (w *ActionWorker) dispatchAutomationEvent(ctx context.Context, action ActionIntent) error {
	if action.SubscriberEmail == nil {
		return &actionExecutionError{
			code:      "invalid_automation_snapshot",
			permanent: true,
			err:       errors.New("automation event recipient is missing"),
		}
	}
	var body any
	if err := json.Unmarshal(action.Body, &body); err != nil {
		return &actionExecutionError{
			code:      "stored_payload_invalid",
			permanent: true,
			err:       errors.New("retained inbound payload is invalid"),
		}
	}
	eventPayload := map[string]any{
		"endpoint_id": action.EndpointID,
		"body":        body,
		"event_name":  inboundWebhookEventName(body),
	}
	if object, ok := body.(map[string]any); ok {
		for key, value := range object {
			eventPayload[key] = value
		}
	}
	payload := map[string]any{
		"tenant_id":        action.TenantID,
		"event_type":       "inbound_webhook",
		"subscriber_email": *action.SubscriberEmail,
		"source_event_id":  action.ID,
		"at":               action.OccurredAt,
		"payload":          eventPayload,
	}
	wire, err := json.Marshal(payload)
	if err != nil {
		return &actionExecutionError{
			code:      "payload_encode_failed",
			permanent: true,
			err:       errors.New("automation payload could not be encoded"),
		}
	}
	if len(wire) > maxAutomationEventWireBytes {
		return &actionExecutionError{
			code:      "automation_payload_too_large",
			permanent: true,
			err:       errors.New("automation payload exceeds the bounded wire contract"),
		}
	}
	targetURL, err := automationclient.EventURL(w.AutomationServiceURL)
	if err != nil {
		return &actionExecutionError{
			code: "automation_url_invalid",
			err:  errors.New("automation service URL is invalid"),
		}
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, targetURL, bytes.NewReader(wire))
	if err != nil {
		return &actionExecutionError{code: "request_build_failed", permanent: true, err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", action.ID)
	if token := strings.TrimSpace(w.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := w.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 10 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return &actionExecutionError{code: "automation_transport", err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	permanent := resp.StatusCode >= 400 && resp.StatusCode < 500 &&
		resp.StatusCode != http.StatusRequestTimeout &&
		resp.StatusCode != http.StatusTooEarly &&
		resp.StatusCode != http.StatusTooManyRequests
	return &actionExecutionError{
		code:       fmt.Sprintf("automation_http_%d", resp.StatusCode),
		httpStatus: resp.StatusCode,
		permanent:  permanent,
		err:        fmt.Errorf("automation service returned %d", resp.StatusCode),
	}
}

func (w *ActionWorker) finish(
	ctx context.Context,
	action ActionIntent,
	state, errorCode string,
	httpStatus int,
) error {
	tx, err := db.WithTenant(ctx, w.Repo.Pool, action.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var triggerID *string
	if err := tx.QueryRow(ctx, `
UPDATE inbound_webhook_action_intents
   SET state = $4,
       lease_token = NULL,
       lease_expires_at = NULL,
       last_error_code = NULLIF($5, ''),
       last_http_status = NULLIF($6, 0),
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND state = 'leased'
   AND lease_token = $3::uuid
RETURNING trigger_id::text`,
		action.TenantID,
		action.ID,
		action.LeaseToken,
		state,
		errorCode,
		httpStatus,
	).Scan(&triggerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("inbound_webhooks: action lease was lost before completion")
		}
		return err
	}
	if triggerID != nil {
		if err := recordFireTx(ctx, tx, action.TenantID, *triggerID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (w *ActionWorker) retry(
	ctx context.Context,
	action ActionIntent,
	errorCode string,
	httpStatus int,
	next time.Time,
) error {
	tx, err := db.WithTenant(ctx, w.Repo.Pool, action.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE inbound_webhook_action_intents
   SET state = 'pending',
       lease_token = NULL,
       lease_expires_at = NULL,
       next_attempt_at = $4,
       last_error_code = NULLIF($5, ''),
       last_http_status = NULLIF($6, 0),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND state = 'leased'
   AND lease_token = $3::uuid`,
		action.TenantID,
		action.ID,
		action.LeaseToken,
		next,
		errorCode,
		httpStatus,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("inbound_webhooks: action lease was lost before retry")
	}
	return tx.Commit(ctx)
}

func (w *ActionWorker) logMatch(action ActionIntent, succeeded bool, errorCode string) {
	if w.Logger != nil {
		level := slog.LevelInfo
		if !succeeded {
			level = slog.LevelWarn
		}
		w.Logger.Log(context.Background(), level, "inbound webhook action terminal",
			"action_id", action.ID,
			"tenant_id", action.TenantID,
			"kind", action.IntentKind,
			"success", succeeded,
			"error_code", errorCode,
			"attempts", action.Attempts)
	}
	if w.MatchLogger == nil || action.IntentKind != ActionIntentTriggerAction {
		return
	}
	match := Match{Executed: succeeded, Error: errorCode}
	if action.TriggerID != nil {
		match.TriggerID = *action.TriggerID
	}
	if action.TriggerName != nil {
		match.Name = *action.TriggerName
	}
	if action.ActionType != nil {
		match.ActionType = *action.ActionType
	}
	if action.ActionTargetID != nil {
		match.ActionTargetID = *action.ActionTargetID
	}
	// The structured logger above deliberately excludes subscriber email. The
	// optional product hook preserves its historical Match contract for
	// in-process audit consumers that already have tenant-local authority.
	if action.SubscriberEmail != nil {
		match.SubscriberEmail = *action.SubscriberEmail
	}
	w.MatchLogger(match)
}

func classifyActionError(err error) (code string, httpStatus int, permanent bool) {
	var executionErr *actionExecutionError
	if errors.As(err, &executionErr) {
		code = executionErr.code
		httpStatus = executionErr.httpStatus
		permanent = executionErr.permanent
	} else {
		code = "action_execution_failed"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "action_timeout", httpStatus, false
	}
	if code == "" {
		code = "action_execution_failed"
	}
	return code, httpStatus, permanent
}

func classifyWorkerLoopError(_ error) string { return "worker_tick_failed" }

func actionRetryDelay(attempt int) time.Duration {
	switch {
	case attempt <= 1:
		return 5 * time.Second
	case attempt == 2:
		return 30 * time.Second
	case attempt == 3:
		return 2 * time.Minute
	case attempt == 4:
		return 10 * time.Minute
	default:
		return time.Hour
	}
}

func shouldExhaustActionRetry(attempt int) bool {
	return attempt >= maxActionAttempts
}
