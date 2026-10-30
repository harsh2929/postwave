// Package worker hosts the Asynq task handler that drives the runtime engine.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/hibiken/asynq"

	"github.com/postwave/postwave/services/automation/internal/listmonk"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

// Handler wraps the runtime.Engine so it can be registered with Asynq's
// ServeMux.
type Handler struct {
	Engine *runtime.Engine
	Logger *slog.Logger
}

// Register binds the automation:execute task type onto the given mux.
func Register(mux *asynq.ServeMux, h *Handler) {
	mux.HandleFunc(runtime.TaskTypeAutomationExecute, h.HandleExecute)
}

// HandleExecute is the Asynq HandlerFunc. Errors are classified into:
//   - permanent (skip retry, send to deadletter): config errors, malformed
//     payload, listmonk 4xx that won't recover.
//   - transient (let asynq retry): network blips, listmonk 5xx.
//
// Terminal-failure event firing: an automation.failed webhook fires
// when (a) we hit a permanent classification (no retry will save it)
// or (b) asynq has exhausted MaxRetry and is about to deadletter on
// this attempt. Both surface to webhook subscribers + Slack
// integrations as one logical "this journey is dead" signal.
func (h *Handler) HandleExecute(ctx context.Context, t *asynq.Task) error {
	var exec runtime.Execution
	if err := json.Unmarshal(t.Payload(), &exec); err != nil {
		// Malformed payload: don't waste retries.
		return fmt.Errorf("%w: unmarshal: %v", asynq.SkipRetry, err)
	}

	if err := h.Engine.Execute(ctx, exec); err != nil {
		if classifyPermanent(err) {
			h.logger().Warn("automation execute permanent failure; deadlettering",
				"automation", exec.AutomationID, "subscriber", exec.SubscriberEmail,
				"node", exec.NodeID, "err", err)
			h.fireFailed(ctx, exec, err, "permanent")
			observeAutomationTask("deadletter_permanent")
			return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
		}
		// On the LAST attempt before DLQ, also fire the terminal event.
		// asynq exposes the current retry count + max retry on the
		// task's context; when they're equal this is the last try.
		retryCount, _ := asynq.GetRetryCount(ctx)
		maxRetry, _ := asynq.GetMaxRetry(ctx)
		if maxRetry > 0 && retryCount >= maxRetry {
			h.logger().Warn("automation execute exhausted retries; deadlettering",
				"automation", exec.AutomationID, "subscriber", exec.SubscriberEmail,
				"node", exec.NodeID, "retries", retryCount, "max", maxRetry, "err", err)
			h.fireFailed(ctx, exec, err, "retries_exhausted")
			observeAutomationTask("deadletter_retries_exhausted")
		}
		// Transient: let Asynq retry per the task's MaxRetry policy.
		observeAutomationTask("retry")
		return err
	}
	observeAutomationTask("ok")
	return nil
}

// RetryDelayFunc caps retry backoff for automation tasks and reacts faster to
// provider rate limits than Asynq's default Sidekiq curve. It is intentionally
// deterministic enough for operations: transient 429s slow down quickly, other
// errors use Asynq's default with a one-hour ceiling.
func RetryDelayFunc(n int, err error, task *asynq.Task) time.Duration {
	if n < 1 {
		n = 1
	}
	var delay time.Duration
	msg := strings.ToLower(errString(err))
	if strings.Contains(msg, "429") || strings.Contains(msg, "rate limit") || strings.Contains(msg, "too many requests") {
		delay = time.Duration(n*n) * time.Minute
	} else {
		delay = asynq.DefaultRetryDelayFunc(n, err, task)
	}
	if delay > time.Hour {
		delay = time.Hour
	}
	if delay < 5*time.Second {
		delay = 5 * time.Second
	}
	observeAutomationRetryDelay(delay)
	return delay
}

// fireFailed emits an automation.failed event via the Engine's
// FanoutEmitter. Best-effort: a failure to emit must NOT bounce the
// task back into asynq's queue (we'd loop forever) so we swallow.
//
// Reaching into Engine.FanoutEmitter rather than wiring a separate
// emitter on the Handler keeps the per-service emit path single-
// sourced — terminal success and terminal failure both go through
// the same pipe.
func (h *Handler) fireFailed(ctx context.Context, exec runtime.Execution, cause error, reason string) {
	if h == nil || h.Engine == nil || h.Engine.FanoutEmitter == nil || exec.TenantID == "" {
		return
	}
	body := map[string]any{
		"tenant_id":        exec.TenantID,
		"automation_id":    exec.AutomationID,
		"subscriber_email": exec.SubscriberEmail,
		"node_id":          exec.NodeID,
		"reason":           reason,
		"error":            errString(cause),
	}
	if err := h.Engine.FanoutEmitter.Emit(ctx, exec.TenantID, "automation.failed", body); err != nil {
		h.logger().Warn("automation.failed emit failed (event lost)",
			"automation", exec.AutomationID,
			"subscriber", exec.SubscriberEmail,
			"err", err.Error())
	}
}

func errString(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}

func (h *Handler) logger() *slog.Logger {
	if h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

// classifyPermanent returns true for errors that should not be retried.
func classifyPermanent(err error) bool {
	// Subscriber missing in our DB → can't proceed; needs upstream fix.
	if errors.Is(err, runtime.ErrAutomationNotFound) {
		return true
	}
	if errors.Is(err, runtime.ErrAutomationAllowanceExceeded) {
		return true
	}
	// Listmonk 4xx (other than 429) is unlikely to fix itself.
	var lmErr *listmonk.HTTPError
	if errors.As(err, &lmErr) {
		if lmErr.Status >= 400 && lmErr.Status < 500 && lmErr.Status != 429 {
			return true
		}
	}
	return false
}
