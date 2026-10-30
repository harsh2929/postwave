// Package runtime implements the automation execution engine.
//
// Lifecycle:
//
//  1. Trigger is invoked (by HTTP handler or upstream listener) with a
//     trigger type + subscriber email. The engine matches it against the
//     Automation's triggers, and if it matches, enqueues an Execution for
//     the entry node.
//  2. Asynq pops the task, calls Engine.Execute. Execute runs the current
//     node and either acks (terminal) or enqueues the successor. Wait nodes
//     are scheduled at now + duration via asynq's ProcessAt.
//  3. Branch nodes evaluate against subscriber attributes (resolved via the
//     SubscriberResolver) and pick true_next / false_next.
//  4. Action nodes mutate Listmonk state via HTTP and advance.
//
// Idempotency: every Execution has a stable id derived from
// (automation, subscriber, node). The StateStore records completion per
// node; Execute is a no-op when invoked on an already-completed node.
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/listmonk"
)

// ListmonkClient is the subset of listmonk.Client the engine uses. Extracted
// to an interface to make testing trivial.
type ListmonkClient interface {
	SendTransactional(ctx context.Context, req listmonk.TransactionalReq) error
	AddTagToSubscriber(ctx context.Context, email, tag string) error
	RemoveTagFromSubscriber(ctx context.Context, email, tag string) error
	UnsubscribeFromAll(ctx context.Context, email string) error
	UpdateSubscriberProperty(ctx context.Context, email, field string, value interface{}) error
}

// ApprovalGate is the optional hook the runtime uses to request human
// approval before executing a flagged node. nil disables the gate (useful
// in tests + the studio tier where approvals are not configured).
//
// On RequestApproval, the implementation should idempotently create a
// pending approval row keyed by (tenantID, automationID, nodeID,
// subscriberEmail) and return whether the approval is currently approved.
// When pending or rejected, the engine halts; when approved, it proceeds.
type ApprovalGate interface {
	// RequiresApproval returns true if this node should be gated for the
	// given tenant. Implementations may consult tenant settings.
	RequiresApproval(ctx context.Context, tenantID, automationID, nodeID string) bool
	// RequestOrCheck creates the approval if it does not yet exist and
	// returns its current Status string ("pending"|"approved"|"rejected"|
	// "expired"). The approvalID returned can be embedded in logs.
	RequestOrCheck(ctx context.Context, tenantID, automationID, nodeID, subscriberEmail string) (status, approvalID string, err error)
}

// Engine wires together the queue, state store, subscriber resolver, and
// listmonk client. It is the single entrypoint to the automation runtime.
type Engine struct {
	Listmonk ListmonkClient
	Store    StateStore
	Queue    Queue
	Resolver SubscriberResolver
	Logger   *slog.Logger
	// Approvals is optional; when non-nil and a node has
	// RequiresApproval=true, the engine routes through it before executing.
	Approvals ApprovalGate
	// UsageMeter is the cross-service monthly commercial authority. One
	// reservation is taken for each admitted journey run, keyed by the stable
	// run identity so task retries never consume the allowance twice.
	UsageMeter        *sharedusage.Meter
	RequireUsageMeter bool
	// FanoutEmitter, when non-nil, is called when a journey reaches its
	// terminal node. The implementation writes a webhook.fanout outbox
	// row that the apps/api gateway expands into per-subscription
	// deliveries. nil disables event firing (tests, dev). Failure on
	// emit is logged but does NOT propagate — the journey has already
	// committed its terminal state, and a flaky outbox write must not
	// cause asynq to retry the (already-completed) execution.
	//
	// We don't fire automation.failed in V1: failure paths return errors
	// that asynq retries until exhausted, with no "give up forever"
	// signal at this layer. Adding it requires hooking asynq's terminal-
	// failure callback, which lives in services/automation/main.go.
	FanoutEmitter FanoutEmitter
	// Email, when non-nil, routes send_email nodes through apps/api, where the
	// send passes the SAME suppression / consent / frequency-cap / quiet-hours /
	// kill-switch stack as a campaign. nil falls back to the legacy
	// direct-to-Listmonk call — which bypasses ALL of that, and which must never
	// be the production path.
	Email EmailEmitter
	// SMS, when non-nil, lets send_sms nodes enqueue a transactional SMS for
	// apps/api to deliver (consent/quiet-hours/cost re-checked there). nil makes
	// send_sms a no-op skip — the dev/test default.
	SMS SMSEmitter
	// Coupon, when non-nil, enqueues a coupon assignment for a coupon_assign
	// node (apps/api owns the discounts pool). nil fails the node closed so a
	// journey cannot advance while withholding the promised entitlement.
	Coupon CouponEmitter
	// ListMembership enqueues a move_to_list action for apps/api, which owns
	// the list membership campaigns send to (see list_membership.go). nil
	// fails the action closed: there is no engine-side fallback, because a
	// Listmonk-only add is invisible to every Moosewave send.
	ListMembership ListMembershipEmitter
	// Webhook, when non-nil, performs the outbound HTTP call for webhook nodes
	// and flow_webhook actions (SSRF-guarded). nil makes them advance as a
	// no-op — the dev/test default.
	Webhook WebhookEmitter
	// Now overrides time.Now (tests). nil → time.Now.
	Now func() time.Time
}

// FanoutEmitter is the narrow interface the engine uses to emit terminal
// events. The Postgres-backed implementation lives in fanout.go and is
// wired in services/automation/main.go.
type FanoutEmitter interface {
	Emit(ctx context.Context, tenantID, eventType string, body any) error
}

// ErrAutomationNotFound is returned when an automation id has no registered graph.
var ErrAutomationNotFound = errors.New("runtime: automation not found")

// ErrSubscriberNotFound is returned when the resolver cannot find the subscriber.
var ErrSubscriberNotFound = errors.New("runtime: subscriber not found")

// ErrTriggerDefinitionChanged means a target that was durably selected for an
// inbound event can no longer find that trigger kind on the automation graph.
// It must remain retry-visible rather than being silently acknowledged.
var ErrTriggerDefinitionChanged = errors.New("runtime: durable trigger definition changed")

// ErrAutomationAllowanceExceeded is permanent for the current task: retrying
// the same queued run cannot create capacity and would only churn the queue.
var ErrAutomationAllowanceExceeded = errors.New("runtime: monthly automation execution allowance exceeded")

// TriggerDisposition records how a durable event was adjudicated. Both values
// are terminal acceptances: queued means an idempotent execution exists in the
// queue; policy_skipped means the automation's re-enrollment policy declined a
// new run, so retrying must not change the decision.
type TriggerDisposition string

const (
	TriggerDispositionQueued        TriggerDisposition = "queued"
	TriggerDispositionPolicySkipped TriggerDisposition = "policy_skipped"
)

// errParkExecution is the sentinel runNode returns for a wait_until_trigger
// node: the execution must PARK at this node (no successor enqueued, node not
// marked completed) until the EventDispatcher resumes it when a matching event
// arrives. Execute recognises it and acks without advancing.
var errParkExecution = errors.New("runtime: park execution until trigger")

// terminatedNodeKey is a reserved CompletedNodes entry the EventDispatcher sets
// when a continuous goal is met mid-flight: the journey is exited and any
// already-scheduled successor no-ops on its next run. It rides the existing
// completed_nodes set (text[]) so no schema change is needed. The "__"
// prefix can't collide with a real node id (ids are UUIDs/slugs).
const terminatedNodeKey = "__terminated__"

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now().UTC()
}

func (e *Engine) log() *slog.Logger {
	if e.Logger != nil {
		return e.Logger
	}
	return slog.Default()
}

// Trigger checks whether the given trigger fires for subscriberEmail under
// automationID, and if so enqueues the entry node Execution.
func (e *Engine) Trigger(ctx context.Context, automationID, triggerType, subscriberEmail string, payload map[string]interface{}) error {
	auto, err := e.Resolver.LookupAutomation(ctx, automationID)
	if err != nil {
		return err
	}
	if auto.Status != "active" {
		return fmt.Errorf("automation %q not active (status=%s)", automationID, auto.Status)
	}
	if !triggerMatches(auto.Triggers, triggerType, payload) {
		e.log().Debug("trigger did not match", "automation", automationID, "trigger", triggerType)
		return nil
	}
	entryID := auto.EntryID
	if entryID == "" && len(auto.Nodes) > 0 {
		entryID = auto.Nodes[0].ID
	}
	if entryID == "" {
		return fmt.Errorf("automation %q has no entry node", automationID)
	}

	// Apply the flow's re-enrollment policy. This is the difference between a
	// journey engine and a fire-once DAG walker: abandoned-cart, win-back,
	// birthday and back-in-stock all require the subscriber to enter again.
	runID, allowed, err := e.nextRunID(ctx, auto, subscriberEmail)
	if err != nil {
		return err
	}
	if !allowed {
		e.log().Debug("re-enrollment declined",
			"automation", automationID, "subscriber", subscriberEmail,
			"policy", string(auto.ReEnrollment))
		return nil
	}

	exec := Execution{
		ID:              NewExecutionID(automationID, subscriberEmail, entryID, runID),
		AutomationID:    automationID,
		TenantID:        auto.TenantID,
		SubscriberEmail: subscriberEmail,
		NodeID:          entryID,
		RunID:           runID,
	}
	if err := e.Store.Upsert(ctx, &ExecutionState{
		TenantID:        auto.TenantID,
		AutomationID:    automationID,
		SubscriberEmail: subscriberEmail,
		RunID:           runID,
		CurrentNodeID:   entryID,
		// A fresh run starts with an EMPTY completed-node set. Leaking it
		// across runs would short-circuit the second journey on its entry
		// node — precisely the original bug.
		CompletedNodes: map[string]time.Time{},
		StartedAt:      e.now(),
		LastAt:         e.now(),
	}); err != nil {
		return err
	}
	e.recordEvent(ctx, JourneyEvent{
		TenantID:        auto.TenantID,
		AutomationID:    automationID,
		SubscriberEmail: subscriberEmail,
		EventType:       "triggered",
		NodeID:          entryID,
		Status:          "queued",
		Payload: map[string]interface{}{
			"trigger_type": triggerType,
			"payload":      payload,
		},
	})
	return e.Queue.Enqueue(ctx, exec, time.Time{})
}

// TriggerDurable accepts one target frozen by a durable inbound-event inbox.
// durableKey must be stable across retries. It drives both the run id and queue
// task id, closing the failure window where Store.Upsert succeeded but the HTTP
// response or outcome-ledger commit was lost: a retry reuses the same run and
// Asynq task instead of enrolling the subscriber twice.
//
// Unlike Trigger, a removed trigger definition is an error. The inbox selected
// this automation while processing the original event; silently treating a
// later definition mismatch as success would discard an intended dispatch.
func (e *Engine) TriggerDurable(
	ctx context.Context,
	automationID, triggerType, subscriberEmail string,
	payload map[string]interface{},
	durableKey string,
) (TriggerDisposition, error) {
	if e == nil || e.Resolver == nil || e.Store == nil || e.Queue == nil {
		return "", errors.New("runtime: durable trigger dependencies are not configured")
	}
	if strings.TrimSpace(durableKey) == "" {
		return "", errors.New("runtime: durable trigger key is required")
	}
	auto, err := e.Resolver.LookupAutomation(ctx, automationID)
	if err != nil {
		return "", err
	}
	if auto.Status != "active" {
		return "", fmt.Errorf("automation %q not active (status=%s)", automationID, auto.Status)
	}
	hasType := false
	for _, trigger := range auto.Triggers {
		if trigger.Type != triggerType {
			continue
		}
		if triggerType == canonical.TriggerLifecycleStageChanged &&
			!canonical.ValidLifecycleTrigger(trigger) {
			return "", fmt.Errorf("%w: automation %q has a non-canonical lifecycle stage", ErrTriggerDefinitionChanged, automationID)
		}
		hasType = true
		break
	}
	if !hasType {
		return "", fmt.Errorf("%w: automation %q no longer has trigger %q", ErrTriggerDefinitionChanged, automationID, triggerType)
	}

	entryID := auto.EntryID
	if entryID == "" && len(auto.Nodes) > 0 {
		entryID = auto.Nodes[0].ID
	}
	if entryID == "" {
		return "", fmt.Errorf("automation %q has no entry node", automationID)
	}

	runID := durableRunID(automationID, durableKey)
	existingRun, err := e.Store.Get(ctx, auto.ID, subscriberEmail, runID)
	if err != nil {
		return "", err
	}
	startedAt := e.now()
	sameRunRetry := existingRun != nil
	if sameRunRetry {
		// Retry the same partially accepted dispatch. Preserve chronology and
		// attempt the stable queue id again. Do not Upsert the entry state below:
		// the queued task may already have advanced while the inbox response was
		// lost, and overwriting current_node here would rewind a live journey.
		startedAt = existingRun.StartedAt
	}
	latest, err := e.Store.LatestRun(ctx, auto.ID, subscriberEmail)
	if err != nil {
		return "", err
	}
	if !sameRunRetry && latest != nil {
		switch auto.ReEnrollment {
		case canonical.ReEnrollAlways:
			// allowed
		case canonical.ReEnrollAfterCooldown:
			cooldown := time.Duration(auto.CooldownHours) * time.Hour
			if cooldown <= 0 || e.now().Sub(latest.StartedAt) < cooldown {
				return TriggerDispositionPolicySkipped, nil
			}
		default:
			return TriggerDispositionPolicySkipped, nil
		}
	}

	exec := Execution{
		ID:              durableExecutionID(automationID, entryID, durableKey),
		AutomationID:    automationID,
		TenantID:        auto.TenantID,
		SubscriberEmail: subscriberEmail,
		NodeID:          entryID,
		RunID:           runID,
	}
	if !sameRunRetry {
		if err := e.Store.Upsert(ctx, &ExecutionState{
			TenantID:        auto.TenantID,
			AutomationID:    automationID,
			SubscriberEmail: subscriberEmail,
			RunID:           runID,
			CurrentNodeID:   entryID,
			CompletedNodes:  map[string]time.Time{},
			StartedAt:       startedAt,
			LastAt:          e.now(),
		}); err != nil {
			return "", err
		}
	}
	if err := e.Queue.Enqueue(ctx, exec, time.Time{}); err != nil {
		return "", err
	}
	// The inbox outcome is the durable trigger receipt. Do not append the
	// legacy best-effort "triggered" journey event here: a crash after enqueue
	// but before the inbox outcome commit would append it again on retry. The
	// queued execution emits the ordinary node/journey timeline as it runs.
	return TriggerDispositionQueued, nil
}

func durableRunID(automationID, durableKey string) string {
	sum := sha256.Sum256([]byte("run\x00" + automationID + "\x00" + durableKey))
	return "evt_" + hex.EncodeToString(sum[:16])
}

func durableExecutionID(automationID, entryID, durableKey string) string {
	sum := sha256.Sum256([]byte("execution\x00" + automationID + "\x00" + entryID + "\x00" + durableKey))
	return "event:" + hex.EncodeToString(sum[:])
}

// Bounds on parking. A flow left paused forever would otherwise re-queue once a
// minute in perpetuity, minting a task each time.
const (
	// maxParkBackoff caps the linear backoff so a long pause settles into a
	// cheap poll rather than a per-minute storm.
	maxParkBackoff = 30 * time.Minute
	// maxParkAttempts is the give-up point. At the capped backoff this is on
	// the order of weeks — far longer than any approval TTL — so reaching it
	// means something is genuinely wrong, and spinning silently forever is
	// worse than stopping loudly.
	maxParkAttempts = 2000
)

// parkRequeue re-schedules an execution that cannot proceed yet — the flow is
// paused, or a node is awaiting human approval.
//
// It exists because the obvious implementation is a silent data-loss bug. Both
// callers used to re-enqueue `exec` UNCHANGED, and exec.ID is the asynq TaskID:
// asynq rejects a duplicate TaskID while the task exists, RedisQueue.Enqueue
// swallows that conflict as "idempotent success", Execute returns nil, and asynq
// then marks the ACTIVE task completed. Nothing was ever rescheduled — no error,
// no DLQ row, and a journey that merely looked like it was "waiting".
//
// The retry therefore gets a NEW id derived from the attempt. A duplicate
// delivery of the SAME attempt still collides and is still dropped, so this
// cannot double-send.
func (e *Engine) parkRequeue(ctx context.Context, exec Execution, base time.Duration, reason string) error {
	attempt := exec.Attempt + 1
	if attempt > maxParkAttempts {
		e.log().Warn("automation execution abandoned after too many parked retries",
			"automation", exec.AutomationID, "node", exec.NodeID,
			"subscriber", exec.SubscriberEmail, "reason", reason, "attempts", attempt)
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "execution_abandoned",
			NodeID:          exec.NodeID,
			Status:          "failed",
			Message:         "abandoned after " + strconv.Itoa(attempt) + " parked retries (" + reason + ")",
		})
		return e.Queue.Ack(ctx, exec)
	}

	backoff := base * time.Duration(attempt)
	if backoff > maxParkBackoff {
		backoff = maxParkBackoff
	}

	retry := exec
	retry.Attempt = attempt
	// Rebuild from the BASE id, not exec.ID — exec may already be a retry, and
	// we must not accumulate ":retry1:retry2:…".
	retry.ID = RetryExecutionID(
		NewExecutionID(exec.AutomationID, exec.SubscriberEmail, exec.NodeID, exec.RunID),
		attempt,
	)
	return e.Queue.Enqueue(ctx, retry, e.now().Add(backoff))
}

// nextRunID applies the flow's re-enrollment policy and returns the run to
// start. allowed=false means the subscriber must not (re-)enter right now.
//
// The zero-value policy is ReEnrollOnce, which reproduces the historical
// fire-once behaviour exactly. That default is deliberate: flipping every
// existing flow to "always" on deploy would re-enroll every subscriber who has
// ever completed one, mass-re-sending the entire back catalogue.
func (e *Engine) nextRunID(ctx context.Context, auto *canonical.Automation, subscriberEmail string) (runID string, allowed bool, err error) {
	latest, err := e.Store.LatestRun(ctx, auto.ID, subscriberEmail)
	if err != nil {
		return "", false, err
	}
	// Never entered before: always allowed, whatever the policy.
	if latest == nil {
		return newRunID(), true, nil
	}

	switch auto.ReEnrollment {
	case canonical.ReEnrollAlways:
		return newRunID(), true, nil

	case canonical.ReEnrollAfterCooldown:
		cooldown := time.Duration(auto.CooldownHours) * time.Hour
		if cooldown <= 0 {
			// A cooldown flow with no cooldown configured would behave as
			// "always". Refuse rather than guess: a mis-set cooldown must not
			// silently become an unbounded re-send.
			return "", false, nil
		}
		if e.now().Sub(latest.StartedAt) < cooldown {
			return "", false, nil
		}
		return newRunID(), true, nil

	default: // canonical.ReEnrollOnce — the zero value.
		return "", false, nil
	}
}

// newRunID mints an opaque, unique run identifier. It only ever needs to be
// distinct from the subscriber's previous runs.
func newRunID() string { return uuid.NewString() }

func triggerMatches(triggers []canonical.AutomationTrigger, triggerType string, payload map[string]interface{}) bool {
	for _, t := range triggers {
		if t.Type != triggerType {
			continue
		}
		// Light payload matching: list / tag / event_name must equal if set. A
		// list is matched against every identity the payload carries (see
		// canonical.MatchListJoined).
		if t.ListID != "" && !canonical.MatchListJoined(t, listJoinedPayloadIDs(payload)...) {
			continue
		}
		if t.Tag != "" && fmt.Sprint(payload["tag"]) != t.Tag {
			continue
		}
		if t.EventName != "" && fmt.Sprint(payload["event_name"]) != t.EventName {
			continue
		}
		return true
	}
	return false
}

// Execute runs the node referenced by exec, then either acks (terminal) or
// enqueues the successor.
func (e *Engine) Execute(ctx context.Context, exec Execution) error {
	ctx = WithTenant(ctx, exec.TenantID)
	paused, err := e.Store.IsPaused(ctx, exec.AutomationID)
	if err != nil {
		return err
	}
	if paused {
		// Re-queue with a 1-minute backoff so we resume after unpause without
		// losing the execution.
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "paused",
			NodeID:          exec.NodeID,
			Status:          "waiting",
			Message:         "automation paused; execution requeued",
		})
		return e.parkRequeue(ctx, exec, time.Minute, "automation paused")
	}

	st, err := e.Store.Get(ctx, exec.AutomationID, exec.SubscriberEmail, exec.RunID)
	if err != nil {
		return err
	}
	// Continuous-goal exit: if a goal was met mid-flight (set by the
	// EventDispatcher), the journey is over — ack any scheduled successor.
	if st != nil && st.CompletedNodes != nil {
		if _, terminated := st.CompletedNodes[terminatedNodeKey]; terminated {
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "journey_exited",
				NodeID:          exec.NodeID,
				Status:          "completed",
				Message:         "goal met; journey exited",
			})
			return e.Queue.Ack(ctx, exec)
		}
	}
	if st != nil && st.CompletedNodes != nil {
		if _, done := st.CompletedNodes[exec.NodeID]; done {
			e.log().Debug("node already completed; skipping",
				"automation", exec.AutomationID, "node", exec.NodeID, "subscriber", exec.SubscriberEmail)
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "node_skipped",
				NodeID:          exec.NodeID,
				Status:          "completed",
				Message:         "node already completed",
			})
			return e.Queue.Ack(ctx, exec)
		}
	}

	auto, err := e.Resolver.LookupAutomation(ctx, exec.AutomationID)
	if err != nil {
		return err
	}
	node := auto.FindNode(exec.NodeID)
	if node == nil {
		return fmt.Errorf("node %q not found in automation %q", exec.NodeID, exec.AutomationID)
	}
	entryID := auto.EntryID
	if entryID == "" && len(auto.Nodes) > 0 {
		entryID = auto.Nodes[0].ID
	}
	if exec.NodeID == entryID {
		if e.RequireUsageMeter && e.UsageMeter == nil {
			return errors.New("runtime: commercial usage meter is required")
		}
		if e.UsageMeter != nil {
			key := "automation:v1:" + exec.AutomationID + ":" + exec.SubscriberEmail + ":" + exec.RunID
			if _, meterErr := e.UsageMeter.Reserve(ctx, exec.TenantID, sharedusage.ResourceAutomationRuns, 1, key, "automation_runtime"); meterErr != nil {
				var limitErr *sharedusage.Error
				if errors.As(meterErr, &limitErr) {
					return fmt.Errorf("%w: %v", ErrAutomationAllowanceExceeded, limitErr)
				}
				return fmt.Errorf("runtime: verify automation allowance: %w", meterErr)
			}
		}
	}

	sub, err := e.Resolver.Resolve(ctx, exec.TenantID, exec.SubscriberEmail)
	if err != nil && !errors.Is(err, ErrSubscriberNotFound) {
		return err
	}

	// Approval gate: when the node should be gated and an ApprovalGate is
	// wired, ask it for status. Pending/rejected halts; approved continues.
	// A manual_review node ALWAYS gates by its type (that is its whole
	// purpose); other nodes gate only when they carry RequiresApproval=true
	// and the tenant's gate opts in.
	if e.Approvals != nil &&
		(node.Type == "manual_review" ||
			(node.RequiresApproval &&
				e.Approvals.RequiresApproval(ctx, exec.TenantID, exec.AutomationID, node.ID))) {
		status, approvalID, aerr := e.Approvals.RequestOrCheck(
			ctx, exec.TenantID, exec.AutomationID, node.ID, exec.SubscriberEmail)
		if aerr != nil {
			return fmt.Errorf("approval gate: %w", aerr)
		}
		switch status {
		case "approved":
			// fall through and run the node
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "approval_approved",
				NodeID:          node.ID,
				Status:          "active",
				Payload:         map[string]interface{}{"approval_id": approvalID},
			})
		case "rejected", "expired":
			e.log().Info("automation node rejected via approval gate",
				"automation", exec.AutomationID, "node", node.ID,
				"approval_id", approvalID, "status", status)
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "approval_" + status,
				NodeID:          node.ID,
				Status:          "completed",
				Payload:         map[string]interface{}{"approval_id": approvalID},
			})
			return e.Queue.Ack(ctx, exec)
		default: // "pending" or anything unexpected
			// Re-queue with a 5-minute backoff; the approval handler should
			// re-enqueue immediately on approve, this is just the safety net.
			e.log().Info("automation node awaiting approval",
				"automation", exec.AutomationID, "node", node.ID,
				"approval_id", approvalID)
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "approval_pending",
				NodeID:          node.ID,
				Status:          "waiting",
				Payload:         map[string]interface{}{"approval_id": approvalID},
			})
			return e.parkRequeue(ctx, exec, 5*time.Minute, "awaiting approval")
		}
	}

	e.recordEvent(ctx, JourneyEvent{
		TenantID:        exec.TenantID,
		AutomationID:    exec.AutomationID,
		SubscriberEmail: exec.SubscriberEmail,
		EventType:       "node_started",
		NodeID:          exec.NodeID,
		Status:          "active",
	})
	nextNodeID, runAt, err := e.runNode(ctx, auto, node, exec, sub)
	if errors.Is(err, errParkExecution) {
		// Park: leave CurrentNodeID at this node so the EventDispatcher can
		// find + resume it on a matching event. Do NOT enqueue a successor or
		// mark the node completed — it has not finished, it is waiting.
		if uerr := e.Store.Upsert(ctx, &ExecutionState{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			RunID:           exec.RunID,
			SubscriberEmail: exec.SubscriberEmail,
			CurrentNodeID:   exec.NodeID,
			LastAt:          e.now(),
		}); uerr != nil {
			return uerr
		}
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "node_waiting_for_trigger",
			NodeID:          exec.NodeID,
			Status:          "waiting",
		})
		return e.Queue.Ack(ctx, exec)
	}
	if err != nil {
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "node_failed",
			NodeID:          exec.NodeID,
			Status:          "failed",
			Message:         err.Error(),
		})
		e.recordStepMetric(ctx, StepMetric{
			TenantID:     exec.TenantID,
			AutomationID: exec.AutomationID,
			NodeID:       exec.NodeID,
			RunID:        exec.RunID,
			ActionKind:   nodeActionKind(node),
			Outcome:      "failed",
			Error:        err.Error(),
		})
		return err
	}

	// IMPORTANT (atomicity, audit Week N+):
	//
	// MarkCompleted is deferred until AFTER Enqueue succeeds (see below).
	// If we marked completed first and then Enqueue failed, the asynq
	// retry would re-enter Execute, see the node in CompletedNodes (line
	// ~197 above), call Ack, and the journey would silently halt forever
	// — no successor scheduled, no operator signal.
	//
	// Order is now: runNode → Upsert → Enqueue → MarkCompleted → Ack.
	// A crash between Upsert and Enqueue causes the next retry to find
	// the node NOT completed and re-execute. That's at-least-once for
	// the side effect (e.g. a send may go out twice), but at-least-once
	// is recoverable; silent halt is not. The completed-node short-
	// circuit upstream catches the duplicate before runNode runs again.
	if err := e.Store.Upsert(ctx, &ExecutionState{
		TenantID:        exec.TenantID,
		AutomationID:    exec.AutomationID,
		RunID:           exec.RunID,
		SubscriberEmail: exec.SubscriberEmail,
		CurrentNodeID:   nextNodeID,
		LastAt:          e.now(),
	}); err != nil {
		return err
	}
	status := "active"
	if !runAt.IsZero() && runAt.After(e.now()) {
		status = "waiting"
	}
	if nextNodeID == "" {
		status = "completed"
	}
	e.recordEvent(ctx, JourneyEvent{
		TenantID:        exec.TenantID,
		AutomationID:    exec.AutomationID,
		SubscriberEmail: exec.SubscriberEmail,
		EventType:       "node_completed",
		NodeID:          exec.NodeID,
		Status:          status,
		Payload: map[string]interface{}{
			"next_node_id": nextNodeID,
			"run_at":       runAt,
		},
	})
	e.recordStepMetric(ctx, StepMetric{
		TenantID:     exec.TenantID,
		AutomationID: exec.AutomationID,
		NodeID:       exec.NodeID,
		RunID:        exec.RunID,
		ActionKind:   nodeActionKind(node),
		Outcome:      "applied",
	})

	if nextNodeID == "" {
		// Terminal: no successor to enqueue. Mark this node completed
		// before Ack so the journey's CompletedNodes set is durable.
		// MarkCompleted failure here returns the error so asynq retries;
		// re-running runNode is bounded by the completed-node check
		// upstream (line ~197) once the prior MarkCompleted DOES land.
		//
		// At-least-once window: same trade-off as the intermediate
		// branch below. If runNode for the terminal node already had
		// observable side effects (e.g. send_email called Listmonk)
		// and MarkCompleted fails, the asynq retry will re-execute
		// runNode → the email goes out twice. This is the same bound
		// as the non-terminal branch — at-least-once for side effects,
		// recoverable journey state. The alternative (MarkCompleted-
		// then-runNode) would give us silent journey halts on a crash
		// between the two, which is worse.
		if err := e.Store.MarkCompleted(ctx, exec.AutomationID, exec.SubscriberEmail, exec.NodeID, exec.RunID); err != nil {
			return err
		}
		e.log().Info("automation finished",
			"automation", exec.AutomationID, "subscriber", exec.SubscriberEmail)
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "completed",
			Status:          "completed",
		})
		// Emit terminal webhook event. Best-effort: a fanout failure
		// must NOT bounce the (already-completed) execution back into
		// the queue, so we swallow the error and only log.
		if e.FanoutEmitter != nil && exec.TenantID != "" {
			if err := e.FanoutEmitter.Emit(ctx, exec.TenantID, "automation.completed", map[string]any{
				"tenant_id":        exec.TenantID,
				"automation_id":    exec.AutomationID,
				"subscriber_email": exec.SubscriberEmail,
				"finished_at":      e.now(),
			}); err != nil {
				e.log().Warn("automation fanout emit failed",
					"automation", exec.AutomationID,
					"subscriber", exec.SubscriberEmail,
					"err", err.Error())
			}
		}
		return e.Queue.Ack(ctx, exec)
	}

	next := Execution{
		ID:              NewExecutionID(exec.AutomationID, exec.SubscriberEmail, nextNodeID, exec.RunID),
		AutomationID:    exec.AutomationID,
		TenantID:        exec.TenantID,
		RunID:           exec.RunID,
		SubscriberEmail: exec.SubscriberEmail,
		NodeID:          nextNodeID,
	}
	// Enqueue successor BEFORE marking the current node completed. If
	// Enqueue fails the retry will re-execute this node — at-least-once
	// for the side effect, but the journey is recoverable.
	if err := e.Queue.Enqueue(ctx, next, runAt); err != nil {
		return err
	}
	// Mark completed AFTER successful enqueue. If MarkCompleted itself
	// fails the retry will re-execute and re-enqueue (which asynq
	// dedupes by NewExecutionID — same automation + subscriber + node
	// hashes to the same task id, so the second enqueue is a no-op).
	if err := e.Store.MarkCompleted(ctx, exec.AutomationID, exec.SubscriberEmail, exec.NodeID, exec.RunID); err != nil {
		return err
	}
	return e.Queue.Ack(ctx, exec)
}

// runNode runs one node and returns (nextNodeID, runAt, err). runAt is the
// time the next node should fire (zero → immediately).
func (e *Engine) runNode(
	ctx context.Context,
	auto *canonical.Automation,
	node *canonical.AutomationNode,
	exec Execution,
	sub canonical.Subscriber,
) (string, time.Time, error) {
	switch node.Type {
	case "wait":
		next := auto.NextNode(node.ID)
		runAt := e.now().Add(time.Duration(node.DurationSeconds) * time.Second)
		e.log().Debug("wait node scheduled",
			"node", node.ID, "duration_s", node.DurationSeconds, "next", next)
		return next, runAt, nil

	case "wait_until":
		next := auto.NextNode(node.ID)
		if node.WaitUntil == nil {
			return "", time.Time{}, fmt.Errorf("wait_until node %q missing wait_until", node.ID)
		}
		runAt := node.WaitUntil.UTC()
		if runAt.Before(e.now()) {
			runAt = time.Time{}
		}
		e.log().Debug("wait_until node scheduled",
			"node", node.ID, "run_at", runAt, "next", next)
		return next, runAt, nil

	case "send_email":
		tpl := strings.TrimSpace(node.TemplateID)
		if tpl == "" {
			return "", time.Time{}, fmt.Errorf("send_email node %q missing template_id", node.ID)
		}
		// Preferred path: hand off to apps/api, which re-checks suppression,
		// consent, frequency caps, quiet hours, the send window and the tenant
		// kill switch — none of which the engine can see. Calling Listmonk from
		// here skipped every one of them, so a flow could mail a suppressed
		// address at 3am past the frequency cap while the tenant was paused.
		//
		// The template id is passed through OPAQUELY. It used to be
		// strconv.Atoi'd, but campaign_templates.id is a uuid, so every Moosewave
		// template failed to parse and the node failed permanently. apps/api
		// resolves a uuid or a numeric listmonk id, exactly as it does for
		// campaigns.
		if e.Email != nil {
			if err := e.Email.Emit(ctx, exec.TenantID, EmailSendRequest{
				SubscriberEmail: exec.SubscriberEmail,
				TemplateID:      tpl,
				AutomationID:    exec.AutomationID,
				NodeID:          node.ID,
				RunID:           exec.RunID,
				Data: map[string]any{
					"automation_id": exec.AutomationID,
					"node_id":       node.ID,
				},
			}); err != nil {
				return "", time.Time{}, fmt.Errorf("automation email enqueue: %w", err)
			}
			return auto.NextNode(node.ID), time.Time{}, nil
		}

		// Legacy fallback (dev/test only — see Engine.Email). Listmonk's
		// transactional API is keyed on an integer template id, so this path
		// cannot express a Moosewave uuid template at all.
		tplID, err := strconv.Atoi(tpl)
		if err != nil {
			return "", time.Time{}, fmt.Errorf(
				"send_email node %q: template_id %q is not a listmonk integer id, and no Email emitter is wired "+
					"(a Moosewave uuid template requires the apps/api delivery path)", node.ID, tpl)
		}
		req := listmonk.TransactionalReq{
			SubscriberEmail: exec.SubscriberEmail,
			TemplateID:      tplID,
			Data: map[string]interface{}{
				"automation_id": exec.AutomationID,
				"node_id":       node.ID,
			},
		}
		if err := e.Listmonk.SendTransactional(ctx, req); err != nil {
			return "", time.Time{}, fmt.Errorf("listmonk send: %w", err)
		}
		return auto.NextNode(node.ID), time.Time{}, nil

	case "send_sms":
		body := strings.TrimSpace(node.SMSBody)
		if body == "" {
			return "", time.Time{}, fmt.Errorf("send_sms node %q missing sms_body", node.ID)
		}
		// Enqueue for apps/api to deliver — it re-checks consent / quiet-hours /
		// cost and owns the provider. A nil emitter (dev/test) advances as a
		// no-op so a graph with SMS nodes still runs.
		if e.SMS != nil {
			if err := e.SMS.Emit(ctx, exec.TenantID, SMSSendRequest{
				SubscriberEmail: exec.SubscriberEmail,
				Phone:           sub.Phone,
				Body:            body,
				AutomationID:    exec.AutomationID,
				NodeID:          node.ID,
			}); err != nil {
				return "", time.Time{}, fmt.Errorf("sms enqueue: %w", err)
			}
		}
		return auto.NextNode(node.ID), time.Time{}, nil

	case "branch":
		if node.Condition == nil {
			return "", time.Time{}, fmt.Errorf("branch node %q missing condition", node.ID)
		}
		ok := Evaluate(*node.Condition, sub)
		var next string
		if ok {
			if node.TrueNext != nil {
				next = *node.TrueNext
			}
		} else {
			if node.FalseNext != nil {
				next = *node.FalseNext
			}
		}
		e.log().Debug("branch evaluated", "node", node.ID, "result", ok, "next", next)
		return next, time.Time{}, nil

	case "goal":
		cond := node.Goal
		if cond == nil {
			cond = node.Condition
		}
		if cond == nil {
			return "", time.Time{}, fmt.Errorf("goal node %q missing goal condition", node.ID)
		}
		if Evaluate(*cond, sub) {
			e.recordEvent(ctx, JourneyEvent{
				TenantID:        exec.TenantID,
				AutomationID:    exec.AutomationID,
				SubscriberEmail: exec.SubscriberEmail,
				EventType:       "goal_met",
				NodeID:          node.ID,
				Status:          "completed",
			})
			// Attribute the conversion to any A/B variant this subscriber was
			// assigned earlier in the flow (best-effort).
			e.recordABConversion(ctx, exec.TenantID, exec.AutomationID, exec.SubscriberEmail)
			return "", time.Time{}, nil
		}
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "goal_not_met",
			NodeID:          node.ID,
			Status:          "active",
		})
		return auto.NextNode(node.ID), time.Time{}, nil

	case "action":
		if node.Action == nil {
			return "", time.Time{}, fmt.Errorf("action node %q missing action", node.ID)
		}
		if err := e.applyAction(ctx, exec, node.ID, node.Action); err != nil {
			return "", time.Time{}, fmt.Errorf("apply action %s: %w", node.Action.Kind, err)
		}
		return auto.NextNode(node.ID), time.Time{}, nil

	case "percentage_split":
		if len(node.Variants) == 0 {
			return "", time.Time{}, fmt.Errorf("percentage_split node %q has no variants", node.ID)
		}
		// Stable per-subscriber bucket → same leg on every re-execution.
		key := exec.AutomationID + "|" + node.ID + "|" + exec.SubscriberEmail
		next := pickSplitVariant(node.Variants, key)
		e.log().Debug("percentage_split routed", "node", node.ID, "next", next)
		return next, time.Time{}, nil

	case "ab_test":
		if len(node.Variants) == 0 {
			return "", time.Time{}, fmt.Errorf("ab_test node %q has no variants", node.ID)
		}
		// Deterministic per-subscriber variant — same bucketing as
		// percentage_split, but we record the assignment so a winner can be
		// derived. Routes down the chosen variant's leg.
		key := exec.AutomationID + "|" + node.ID + "|" + exec.SubscriberEmail
		variant := pickABVariant(node.Variants, key)
		if variant == nil {
			return "", time.Time{}, fmt.Errorf("ab_test node %q produced no variant", node.ID)
		}
		e.recordABAssignment(ctx, ABAssignment{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			NodeID:          node.ID,
			SubscriberEmail: exec.SubscriberEmail,
			VariantID:       variant.ID,
		})
		return variant.Next, time.Time{}, nil

	case "coupon_assign":
		poolID, _ := node.Metadata["coupon_pool_id"].(string)
		if strings.TrimSpace(poolID) == "" {
			return "", time.Time{}, fmt.Errorf("coupon_assign node %q missing coupon_pool_id", node.ID)
		}
		if e.Coupon == nil {
			return "", time.Time{}, fmt.Errorf("coupon_assign node %q unavailable: coupon allocation is release-contained", node.ID)
		}
		// apps/api reserves/assigns a code from the pool when the production
		// availability gate is explicitly enabled. Enqueue failure is surfaced
		// so the node retries without advancing the journey.
		if err := e.Coupon.Emit(ctx, exec.TenantID, CouponAssignRequest{
			PoolID:          poolID,
			SubscriberEmail: exec.SubscriberEmail,
			AutomationID:    exec.AutomationID,
			NodeID:          node.ID,
		}); err != nil {
			return "", time.Time{}, fmt.Errorf("coupon_assign enqueue: %w", err)
		}
		return auto.NextNode(node.ID), time.Time{}, nil

	case "webhook":
		body := strings.TrimSpace(node.WebhookURL)
		if body == "" {
			return "", time.Time{}, fmt.Errorf("webhook node %q missing webhook_url", node.ID)
		}
		if e.Webhook != nil {
			if err := e.Webhook.Send(ctx, WebhookRequest{
				URL:    node.WebhookURL,
				Method: node.WebhookMethod,
				Payload: map[string]interface{}{
					"automation_id":    exec.AutomationID,
					"node_id":          node.ID,
					"subscriber_email": exec.SubscriberEmail,
					"tenant_id":        exec.TenantID,
				},
				AutomationID: exec.AutomationID,
				NodeID:       node.ID,
			}); err != nil {
				return "", time.Time{}, fmt.Errorf("webhook node: %w", err)
			}
		}
		return auto.NextNode(node.ID), time.Time{}, nil

	case "manual_review":
		// The review gate (above) is the whole point; the node body is a
		// pass-through that advances once approved (or immediately when no
		// ApprovalGate is wired — the studio/dev default).
		return auto.NextNode(node.ID), time.Time{}, nil

	case "wait_until_trigger":
		if node.WaitTrigger == nil {
			return "", time.Time{}, fmt.Errorf("wait_until_trigger node %q missing wait_trigger", node.ID)
		}
		// Park here: the EventDispatcher resumes this execution (enqueuing the
		// successor) when an event matching WaitTrigger arrives for this
		// subscriber. No successor is scheduled now.
		return "", time.Time{}, errParkExecution

	case "exit":
		// An explicit end to the journey. The flowbuilder catalog has always
		// advertised this as RuntimeStatus:"supported" and Validate() reports
		// Executable:true for a graph containing it — but there was no case for
		// it here, so it fell through to `unknown node type "exit"`, failed,
		// retried 5 times and deadlettered. The project's own flowbuilder test
		// builds a graph terminating in {ID:"end", Type:"exit"}.
		//
		// Terminal: no successor. Returning an empty next-node id is how every
		// other terminal path (goal met, terminal action) signals completion.
		e.recordEvent(ctx, JourneyEvent{
			TenantID:        exec.TenantID,
			AutomationID:    exec.AutomationID,
			SubscriberEmail: exec.SubscriberEmail,
			EventType:       "exited",
			NodeID:          node.ID,
			Status:          "completed",
		})
		return "", time.Time{}, nil

	default:
		return "", time.Time{}, fmt.Errorf("unknown node type %q", node.Type)
	}
}

func (e *Engine) applyAction(ctx context.Context, exec Execution, nodeID string, a *canonical.AutomationAction) error {
	email := exec.SubscriberEmail
	switch a.Kind {
	case "add_tag":
		return e.Listmonk.AddTagToSubscriber(ctx, email, a.Tag)
	case "remove_tag":
		return e.Listmonk.RemoveTagFromSubscriber(ctx, email, a.Tag)
	case "move_to_list":
		// Despite the name this ADDS to the list, as the bulk verb of the same
		// name does: nobody is removed from their other lists.
		listID := strings.TrimSpace(a.ListID)
		if listID == "" {
			return fmt.Errorf("move_to_list action missing list_id")
		}
		if e.ListMembership == nil {
			return errors.New("move_to_list requires the list-membership emitter; " +
				"an engine-only add would never reach the list campaigns send to")
		}
		return e.ListMembership.Emit(ctx, exec.TenantID, ListMembershipRequest{
			SubscriberEmail: email,
			ListID:          listID,
			AutomationID:    exec.AutomationID,
			NodeID:          nodeID,
			RunID:           exec.RunID,
		})
	case "unsubscribe":
		return e.Listmonk.UnsubscribeFromAll(ctx, email)
	case "update_profile_property":
		if strings.TrimSpace(a.Field) == "" {
			return fmt.Errorf("update_profile_property action missing field")
		}
		return e.Listmonk.UpdateSubscriberProperty(ctx, email, a.Field, a.Value)
	case "flow_webhook":
		if strings.TrimSpace(a.URL) == "" {
			return fmt.Errorf("flow_webhook action missing url")
		}
		if e.Webhook == nil {
			return nil // no emitter wired (dev/test) — no-op
		}
		return e.Webhook.Send(ctx, WebhookRequest{
			URL: a.URL, // Method defaults to POST in the emitter
			Payload: map[string]interface{}{
				"subscriber_email": email,
				"action":           "flow_webhook",
			},
		})
	}
	return fmt.Errorf("unknown action kind %q", a.Kind)
}

func (e *Engine) recordEvent(ctx context.Context, ev JourneyEvent) {
	if e == nil || e.Store == nil {
		return
	}
	if ev.At.IsZero() {
		ev.At = e.now()
	}
	if err := e.Store.RecordEvent(ctx, ev); err != nil {
		e.log().Warn("automation event record failed",
			"automation", ev.AutomationID, "event_type", ev.EventType, "err", err.Error())
	}
}

// nodeActionKind returns the granular kind recorded in flow_step_metrics:
// action nodes report their concrete Action.Kind (add_tag / remove_tag / …) so
// the inspector can distinguish them; every other node type reports its Type
// (wait / branch / send_email / webhook / …).
func nodeActionKind(node *canonical.AutomationNode) string {
	if node == nil {
		return ""
	}
	if node.Type == "action" && node.Action != nil && node.Action.Kind != "" {
		return node.Action.Kind
	}
	return node.Type
}

// recordStepMetric rolls one node-execution outcome into the flow_step_metrics
// counter for the inspector. Strictly best-effort and nil-safe, mirroring
// recordEvent: a metric write must NEVER affect flow execution, so all errors
// are swallowed + logged. Incomplete keys are dropped silently (the store would
// reject them anyway).
func (e *Engine) recordStepMetric(ctx context.Context, m StepMetric) {
	if e == nil || e.Store == nil {
		return
	}
	if m.AutomationID == "" || m.NodeID == "" || m.ActionKind == "" {
		return
	}
	if err := e.Store.RecordStepMetric(ctx, m); err != nil {
		e.log().Warn("automation step metric record failed",
			"automation", m.AutomationID, "node", m.NodeID, "outcome", m.Outcome, "err", err.Error())
	}
}

// recordABAssignment persists a subscriber→variant A/B bucketing. Best-effort
// and nil-safe, mirroring recordStepMetric: a recording failure must NEVER
// affect flow routing (the subscriber has already been routed to variant.Next).
func (e *Engine) recordABAssignment(ctx context.Context, a ABAssignment) {
	if e == nil || e.Store == nil {
		return
	}
	if a.AutomationID == "" || a.NodeID == "" || a.SubscriberEmail == "" || a.VariantID == "" {
		return
	}
	if err := e.Store.RecordABAssignment(ctx, a); err != nil {
		e.log().Warn("automation ab assignment record failed",
			"automation", a.AutomationID, "node", a.NodeID, "variant", a.VariantID, "err", err.Error())
	}
}

// recordABConversion attributes a goal-met to the subscriber's A/B variant(s).
// Best-effort and nil-safe.
func (e *Engine) recordABConversion(ctx context.Context, tenantID, automationID, subscriberEmail string) {
	if e == nil || e.Store == nil || automationID == "" || subscriberEmail == "" {
		return
	}
	if _, err := e.Store.RecordABConversion(ctx, tenantID, automationID, subscriberEmail); err != nil {
		e.log().Warn("automation ab conversion record failed",
			"automation", automationID, "err", err.Error())
	}
}
