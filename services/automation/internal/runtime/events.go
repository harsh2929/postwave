// events.go wires the engagement-event ingest endpoint into the engine.
//
// The apps/api gateway POSTs canonical Listmonk events to
// /v1/automations/event after persisting them in subscriber_events. We
// match each event against every active automation's triggers and, for
// matches, call Engine.Trigger to enqueue the entry node.
//
// Three new trigger types are supported here:
//
//   - subscriber_opened_email(campaign_id?, within_days?)
//   - subscriber_clicked_link(campaign_id?, url_pattern?, within_days?)
//   - subscriber_did_not_open(campaign_id, after_days)
//
// The first two evaluate inline (the event itself is the "fired" signal).
// The third is fundamentally a no-event signal: it cannot be evaluated at
// event time, only at evaluator time. We therefore schedule a one-shot
// evaluator job at campaign.sent_at + after_days; the worker consumes
// these via the same Asynq queue. When it pops, it queries
// subscriber_events for opens; if none, fires the trigger.

package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/httpbody"
)

// Trigger type discriminators on the wire.
const (
	TriggerOpenedEmail          = "subscriber_opened_email"
	TriggerClickedLink          = "subscriber_clicked_link"
	TriggerDidNotOpen           = "subscriber_did_not_open"
	eventJSONMaxBodyBytes int64 = 64 << 10
	wireEventOpened             = "opened"
	wireEventClicked            = "clicked"
	wireEventBounced            = "bounced"
	wireEventComplained         = "complained"
	wireEventUnsubscribed       = "unsubscribed"
)

// ErrEventContinuationFailed means at least one already-running journey could
// not durably apply an event (for example, its wait successor was not accepted
// by the queue). Callers must not acknowledge the source event as fully
// accepted; replay is safe for the continuation because execution IDs are
// stable and the wait node remains incomplete until enqueue succeeds.
var ErrEventContinuationFailed = errors.New("event continuation failed")

// EngagementEvent is the payload posted by the apps/api ingester.
//
// It mirrors apps/api/internal/listmonk_events.CanonicalEvent on the wire
// but is decoded here independently to keep the runtime free of any apps/
// import (LICENSE-BOUNDARY rule: services don't depend on apps).
type EngagementEvent struct {
	TenantID           string    `json:"tenant_id"`
	SubscriberID       string    `json:"subscriber_id,omitempty"`
	SubscriberEmail    string    `json:"subscriber_email,omitempty"`
	EventType          string    `json:"event_type"`
	SourceEventID      string    `json:"source_event_id,omitempty"`
	TransitionSequence int64     `json:"transition_sequence,omitempty"`
	CampaignID         string    `json:"campaign_id,omitempty"`
	LinkURL            string    `json:"link_url,omitempty"`
	UserAgent          string    `json:"user_agent,omitempty"`
	IP                 string    `json:"ip,omitempty"`
	At                 time.Time `json:"at"`
	// Payload carries the event-type-specific bag of attributes the
	// apps/api forwarder populates for platform-domain events
	// (product_event, inbound_webhook, email_reply). Engagement-trigger
	// events ignore this.
	Payload map[string]interface{} `json:"payload,omitempty"`
}

// AutomationLister returns the active automations for a tenant. Implemented
// by a postgres-backed resolver in production; tests use MemoryResolver
// extended with ListActiveByTenant.
type AutomationLister interface {
	ListActiveByTenant(ctx context.Context, tenantID string) ([]*canonical.Automation, error)
}

// EventDispatcher routes incoming engagement events to matching automations.
type EventDispatcher struct {
	Engine *Engine
	Lister AutomationLister
	// LifecycleInbox is mandatory for lifecycle-stage events. Those events
	// carry a stable source id and aggregate sequence and must never fall back
	// to HandleEvent's best-effort, non-deduplicated dispatch loop.
	LifecycleInbox LifecycleEventInbox
	// OpenLookup answers "has this subscriber opened campaign C since time T?"
	// for the did_not_open evaluator. Production wires it to a query against
	// subscriber_events; tests provide an in-memory closure.
	OpenLookup func(ctx context.Context, tenantID, email, campaignID string, since time.Time) (bool, error)
}

// HandleEvent matches ev against every active automation for ev.TenantID and
// triggers the matching ones. It is the entry point for both the HTTP
// endpoint and the did_not_open evaluator (the evaluator synthesises a
// "did_not_open"-shaped event before calling this).
func (d *EventDispatcher) HandleEvent(ctx context.Context, ev EngagementEvent) error {
	if d.Lister == nil {
		return errors.New("event dispatcher: nil lister")
	}
	autos, err := d.Lister.ListActiveByTenant(ctx, ev.TenantID)
	if err != nil {
		return fmt.Errorf("list automations: %w", err)
	}
	for _, a := range autos {
		for _, t := range a.Triggers {
			if !matchesEngagementTrigger(t, ev) && !matchPlatformTrigger(t, ev) {
				continue
			}
			payload := map[string]interface{}{}
			for k, v := range ev.Payload {
				payload[k] = v
			}
			payload["campaign_id"] = ev.CampaignID
			payload["link_url"] = ev.LinkURL
			payload["event_type"] = ev.EventType
			payload["at"] = ev.At
			if _, ok := payload["event_name"]; !ok {
				payload["event_name"] = eventName(ev)
			}
			if d.Engine != nil {
				d.Engine.recordEvent(WithTenant(ctx, ev.TenantID), JourneyEvent{
					TenantID:        ev.TenantID,
					AutomationID:    a.ID,
					SubscriberEmail: ev.SubscriberEmail,
					EventType:       "engagement_" + ev.EventType,
					Status:          "matched",
					Payload:         payload,
					At:              ev.At,
				})
			}
			if err := d.Engine.Trigger(WithTenant(ctx, ev.TenantID), a.ID, t.Type, ev.SubscriberEmail, payload); err != nil {
				// Don't fail the whole batch; one bad automation shouldn't
				// suppress the rest. The engine logs.
				if d.Engine != nil {
					d.Engine.log().Warn("event dispatch trigger failed",
						"automation", a.ID, "trigger", t.Type, "err", err.Error())
				}
				continue
			}
			break // one trigger per automation per event
		}
	}
	// After firing entry triggers, process this subscriber's in-flight
	// executions: exit any journey whose continuous goal is now met, and
	// resume any parked wait_until_trigger whose WaitTrigger matches.
	return d.processInflightOnEvent(ctx, ev, autos)
}

// processInflightOnEvent scans the event's subscriber's active executions and,
// per automation: (1) exits the journey if any goal node's condition now holds
// (continuous-goal conversion), or (2) resumes a parked wait_until_trigger node
// when an event matching its WaitTrigger arrives. Both are idempotent — the
// terminated/completed sentinels make a repeat event a no-op.
func (d *EventDispatcher) processInflightOnEvent(ctx context.Context, ev EngagementEvent, autos []*canonical.Automation) error {
	if d.Engine == nil || d.Engine.Store == nil || d.Engine.Queue == nil {
		return nil
	}
	states, err := d.Engine.Store.ListActive(ctx, ev.TenantID)
	if err != nil {
		d.Engine.log().Warn("inflight scan: list active failed", "err", err.Error())
		return errors.Join(ErrEventContinuationFailed, fmt.Errorf("list active executions: %w", err))
	}
	var failures []error
	byID := make(map[string]*canonical.Automation, len(autos))
	for _, a := range autos {
		byID[a.ID] = a
	}
	tctx := WithTenant(ctx, ev.TenantID)

	// Resolve the event's subscriber once (lazily) for goal evaluation.
	var sub canonical.Subscriber
	subResolved := false
	resolveSub := func() canonical.Subscriber {
		if !subResolved {
			subResolved = true
			if d.Engine.Resolver != nil {
				if s, rerr := d.Engine.Resolver.Resolve(tctx, ev.TenantID, ev.SubscriberEmail); rerr == nil {
					sub = s
				}
			}
		}
		return sub
	}

	for _, st := range states {
		if st.SubscriberEmail != ev.SubscriberEmail {
			continue
		}
		auto := byID[st.AutomationID]
		if auto == nil {
			continue
		}
		if _, exited := st.CompletedNodes[terminatedNodeKey]; exited {
			continue // already exited
		}
		// 1. Continuous-goal exit: a met goal ends the journey regardless of
		//    where the subscriber currently sits.
		if goalMet(auto, resolveSub()) {
			if err := d.Engine.Store.MarkCompleted(tctx, auto.ID, st.SubscriberEmail, terminatedNodeKey, st.RunID); err != nil {
				d.Engine.log().Warn("inflight scan: goal-exit mark failed",
					"automation", auto.ID, "err", err.Error())
				failures = append(failures, errors.Join(
					ErrEventContinuationFailed,
					fmt.Errorf("automation %s goal exit: %w", auto.ID, err),
				))
				continue
			}
			d.Engine.recordEvent(tctx, JourneyEvent{
				TenantID:        ev.TenantID,
				AutomationID:    auto.ID,
				SubscriberEmail: st.SubscriberEmail,
				EventType:       "goal_exit",
				Status:          "completed",
				Message:         "goal met mid-flight; journey exited",
			})
			continue
		}
		// 2. Resume a parked wait_until_trigger.
		node := auto.FindNode(st.CurrentNodeID)
		if node == nil || node.Type != "wait_until_trigger" || node.WaitTrigger == nil {
			continue
		}
		if _, done := st.CompletedNodes[node.ID]; done {
			continue // already resumed by an earlier matching event
		}
		if !matchesEngagementTrigger(*node.WaitTrigger, ev) && !matchPlatformTrigger(*node.WaitTrigger, ev) {
			continue
		}
		next := auto.NextNode(node.ID)
		if next != "" {
			resume := Execution{
				ID:              NewExecutionID(auto.ID, st.SubscriberEmail, next, st.RunID),
				AutomationID:    auto.ID,
				TenantID:        ev.TenantID,
				RunID:           st.RunID,
				SubscriberEmail: st.SubscriberEmail,
				NodeID:          next,
			}
			// Enqueue before completing the parked node. If the queue rejects the
			// successor, the matching event can be retried because the wait node
			// remains incomplete. If enqueue succeeds but the state write fails,
			// the retry uses the same execution ID and the durable queue dedupes it.
			if err := d.Engine.Queue.Enqueue(tctx, resume, time.Time{}); err != nil {
				d.Engine.log().Warn("resume parked: enqueue failed",
					"automation", auto.ID, "err", err.Error())
				failures = append(failures, errors.Join(
					ErrEventContinuationFailed,
					fmt.Errorf("automation %s enqueue wait successor: %w", auto.ID, err),
				))
				continue
			}
		}
		if err := d.Engine.Store.MarkCompleted(tctx, auto.ID, st.SubscriberEmail, node.ID, st.RunID); err != nil {
			d.Engine.log().Warn("resume parked: mark completed failed",
				"automation", auto.ID, "err", err.Error())
			failures = append(failures, errors.Join(
				ErrEventContinuationFailed,
				fmt.Errorf("automation %s complete wait node: %w", auto.ID, err),
			))
			continue
		}
		d.Engine.recordEvent(tctx, JourneyEvent{
			TenantID:        ev.TenantID,
			AutomationID:    auto.ID,
			SubscriberEmail: st.SubscriberEmail,
			EventType:       "resumed_from_trigger",
			NodeID:          node.ID,
			Status:          "active",
		})
	}
	return errors.Join(failures...)
}

// goalMet reports whether any goal node in auto has a condition that the
// subscriber currently satisfies — the continuous-conversion exit check.
func goalMet(auto *canonical.Automation, sub canonical.Subscriber) bool {
	for i := range auto.Nodes {
		n := &auto.Nodes[i]
		if n.Type != "goal" {
			continue
		}
		cond := n.Goal
		if cond == nil {
			cond = n.Condition
		}
		if cond != nil && Evaluate(*cond, sub) {
			return true
		}
	}
	return false
}

// matchesEngagementTrigger reports whether trigger t fires for event ev.
//
// Only the new engagement trigger types are matched here; legacy triggers
// (list_join, tag_added, custom_event, date_field) are matched by the
// existing triggerMatches in engine.go.
func matchesEngagementTrigger(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	switch t.Type {
	case TriggerOpenedEmail:
		if ev.EventType != wireEventOpened {
			return false
		}
		if t.CampaignID != "" && t.CampaignID != ev.CampaignID {
			return false
		}
		if t.WithinDays > 0 && time.Since(ev.At) > time.Duration(t.WithinDays)*24*time.Hour {
			return false
		}
		return true
	case TriggerClickedLink:
		if ev.EventType != wireEventClicked {
			return false
		}
		if t.CampaignID != "" && t.CampaignID != ev.CampaignID {
			return false
		}
		if t.URLPattern != "" && !strings.Contains(ev.LinkURL, t.URLPattern) {
			return false
		}
		if t.WithinDays > 0 && time.Since(ev.At) > time.Duration(t.WithinDays)*24*time.Hour {
			return false
		}
		return true
	case TriggerDidNotOpen:
		// did_not_open events are synthesised by the evaluator job — they
		// arrive here with EventType "did_not_open" and a CampaignID. The
		// evaluator already checked that no open exists; matching is just
		// a campaign-id equality check (after_days is honored at scheduling).
		if ev.EventType != TriggerDidNotOpen {
			return false
		}
		if t.CampaignID == "" || t.CampaignID != ev.CampaignID {
			return false
		}
		return true
	}
	return false
}

// ScheduleDidNotOpenEvaluator queues a one-shot evaluator job at
// sentAt + afterDays. When the worker pops it, it calls EvaluateDidNotOpen
// which queries subscriber_events; if no open is found, it dispatches a
// synthesised did_not_open event into HandleEvent.
//
// Idempotency: evaluator-job ids are deterministic
// ("dno|"+automation_id+"|"+email+"|"+campaign_id) so re-scheduling the
// same evaluator is a no-op at the queue level.
func (d *EventDispatcher) ScheduleDidNotOpenEvaluator(
	ctx context.Context, queue Queue,
	tenantID, automationID, email, campaignID string,
	sentAt time.Time, afterDays int,
) error {
	runAt := sentAt.Add(time.Duration(afterDays) * 24 * time.Hour)
	exec := Execution{
		ID:              "dno|" + automationID + "|" + email + "|" + campaignID,
		AutomationID:    automationID,
		TenantID:        tenantID,
		SubscriberEmail: email,
		// NodeID encodes the evaluator type so the worker can route. The
		// engine's Execute is bypassed: the asynq mux is expected to inspect
		// NodeID prefix "__dno__:" and route to EvaluateDidNotOpen instead.
		NodeID: "__dno__:" + campaignID,
	}
	return queue.Enqueue(ctx, exec, runAt)
}

// EvaluateDidNotOpen is the evaluator-job handler. It checks subscriber_events
// via OpenLookup; if there is no open since sentAt, it synthesises a
// did_not_open event and feeds it through HandleEvent.
func (d *EventDispatcher) EvaluateDidNotOpen(
	ctx context.Context, tenantID, email, campaignID string, sentAt time.Time,
) error {
	if d.OpenLookup == nil {
		return errors.New("event dispatcher: nil open lookup")
	}
	opened, err := d.OpenLookup(ctx, tenantID, email, campaignID, sentAt)
	if err != nil {
		return fmt.Errorf("open lookup: %w", err)
	}
	if opened {
		return nil
	}
	return d.HandleEvent(ctx, EngagementEvent{
		TenantID:        tenantID,
		SubscriberEmail: email,
		EventType:       TriggerDidNotOpen,
		CampaignID:      campaignID,
		At:              time.Now().UTC(),
	})
}

// HTTPHandler returns an http.HandlerFunc that decodes an EngagementEvent
// from the request body and calls HandleEvent. Mounted by main.go at
// POST /v1/automations/event.
func (d *EventDispatcher) HTTPHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var ev EngagementEvent
		if err := httpbody.DecodeJSON(w, r, eventJSONMaxBodyBytes, &ev); err != nil {
			writeEventErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.Message(err))
			return
		}
		if ev.TenantID == "" || ev.EventType == "" {
			writeEventErr(w, http.StatusBadRequest, "missing_field",
				"tenant_id and event_type required")
			return
		}
		if ev.EventType == canonical.TriggerLifecycleStageChanged {
			if strings.TrimSpace(ev.SourceEventID) == "" || strings.TrimSpace(ev.SubscriberID) == "" {
				writeEventErr(w, http.StatusBadRequest, "missing_field",
					"subscriber_id, source_event_id, and transition_sequence required for lifecycle events")
				return
			}
			idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			if idempotencyKey == "" || idempotencyKey != strings.TrimSpace(ev.SourceEventID) {
				writeEventErr(w, http.StatusBadRequest, "idempotency_mismatch",
					"Idempotency-Key must exactly match source_event_id")
				return
			}
			if d.LifecycleInbox == nil {
				w.Header().Set("Retry-After", "1")
				writeEventErr(w, http.StatusServiceUnavailable, "lifecycle_inbox_unavailable",
					"durable lifecycle event ingestion is unavailable")
				return
			}
			if err := d.LifecycleInbox.Dispatch(r.Context(), ev); err != nil {
				switch {
				case errors.Is(err, ErrInvalidLifecycleEvent):
					writeEventErr(w, http.StatusUnprocessableEntity, "invalid_lifecycle_event", err.Error())
				case errors.Is(err, ErrLifecycleEventConflict):
					writeEventErr(w, http.StatusConflict, "lifecycle_event_conflict",
						"source_event_id or transition_sequence conflicts with an existing receipt")
				case errors.Is(err, ErrLifecycleEventOutOfOrder):
					w.Header().Set("Retry-After", "1")
					writeEventErr(w, http.StatusTooEarly, "lifecycle_event_out_of_order",
						"an earlier lifecycle transition must be accepted first")
				case errors.Is(err, ErrLifecycleSubscriberAbsent):
					writeEventErr(w, http.StatusNotFound, "lifecycle_subscriber_not_found",
						"subscriber is not tenant-visible")
				case errors.Is(err, ErrLifecycleInboxUnavailable), errors.Is(err, ErrLifecycleDispatchFailed):
					w.Header().Set("Retry-After", "1")
					writeEventErr(w, http.StatusServiceUnavailable, "lifecycle_dispatch_unavailable",
						"lifecycle event was not fully accepted; retry with the same source_event_id")
				default:
					w.Header().Set("Retry-After", "1")
					writeEventErr(w, http.StatusInternalServerError, "lifecycle_dispatch_failed",
						"lifecycle event was not fully accepted")
				}
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
			return
		}
		if sourceEventID := strings.TrimSpace(ev.SourceEventID); sourceEventID != "" {
			if strings.TrimSpace(ev.SubscriberEmail) == "" {
				writeEventErr(w, http.StatusBadRequest, "missing_field", "subscriber_email required")
				return
			}
			idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			if idempotencyKey == "" || idempotencyKey != sourceEventID {
				writeEventErr(w, http.StatusBadRequest, "idempotency_mismatch",
					"Idempotency-Key must exactly match source_event_id")
				return
			}
			if err := d.HandleDurableEvent(r.Context(), ev); err != nil {
				w.Header().Set("Retry-After", "1")
				writeEventErr(w, http.StatusServiceUnavailable, "durable_dispatch_failed",
					"event was not fully accepted; retry with the same source_event_id")
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
			return
		}
		if strings.TrimSpace(r.Header.Get("Idempotency-Key")) != "" {
			writeEventErr(w, http.StatusBadRequest, "idempotency_mismatch",
				"source_event_id is required when Idempotency-Key is supplied")
			return
		}
		if ev.SubscriberEmail == "" {
			writeEventErr(w, http.StatusBadRequest, "missing_field", "subscriber_email required")
			return
		}
		if ev.At.IsZero() {
			ev.At = time.Now().UTC()
		}
		if err := d.HandleEvent(r.Context(), ev); err != nil {
			if errors.Is(err, ErrEventContinuationFailed) {
				w.Header().Set("Retry-After", "1")
				writeEventErr(w, http.StatusServiceUnavailable, "continuation_failed",
					"event was not fully accepted; retry the same event")
				return
			}
			writeEventErr(w, http.StatusInternalServerError, "dispatch_failed", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
	}
}

func writeEventErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
