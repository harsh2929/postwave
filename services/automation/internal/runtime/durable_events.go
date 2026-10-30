package runtime

import (
	"context"
	"errors"
	"fmt"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// ErrDurableEventDispatchFailed means at least one target or in-flight
// continuation did not durably accept an idempotent event. The caller must
// retry with the same source event id.
var ErrDurableEventDispatchFailed = errors.New("durable automation event dispatch failed")

// HandleDurableEvent is the idempotency-aware counterpart to HandleEvent.
// Every matching automation receives a stable TriggerDurable key derived from
// the gateway's durable action intent. Partial retries therefore resume the
// same automation run/task instead of enrolling the subscriber twice.
func (d *EventDispatcher) HandleDurableEvent(ctx context.Context, ev EngagementEvent) error {
	if d == nil || d.Lister == nil || d.Engine == nil {
		return errors.Join(ErrDurableEventDispatchFailed,
			errors.New("event dispatcher durable dependencies are unavailable"))
	}
	if ev.SourceEventID == "" {
		return errors.Join(ErrDurableEventDispatchFailed,
			errors.New("durable event source id is required"))
	}
	automations, err := d.Lister.ListActiveByTenant(ctx, ev.TenantID)
	if err != nil {
		return errors.Join(ErrDurableEventDispatchFailed,
			fmt.Errorf("list automations: %w", err))
	}
	var failures []error
	for _, automation := range automations {
		triggerType, matched := durableEventTriggerType(automation, ev)
		if !matched {
			continue
		}
		payload := durableEventPayload(ev)
		if _, err := d.Engine.TriggerDurable(
			WithTenant(ctx, ev.TenantID),
			automation.ID,
			triggerType,
			ev.SubscriberEmail,
			payload,
			ev.SourceEventID,
		); err != nil {
			d.Engine.log().Warn("durable event trigger failed",
				"automation", automation.ID,
				"trigger", triggerType,
				"source_event_id", ev.SourceEventID,
				"err", err.Error())
			failures = append(failures, fmt.Errorf("automation %s: %w", automation.ID, err))
		}
	}
	if err := d.processInflightOnEvent(ctx, ev, automations); err != nil {
		failures = append(failures, err)
	}
	if len(failures) > 0 {
		return errors.Join(append([]error{ErrDurableEventDispatchFailed}, failures...)...)
	}
	return nil
}

func durableEventTriggerType(automation *canonical.Automation, ev EngagementEvent) (string, bool) {
	if automation == nil {
		return "", false
	}
	for _, trigger := range automation.Triggers {
		if matchesEngagementTrigger(trigger, ev) || matchPlatformTrigger(trigger, ev) {
			return trigger.Type, true
		}
	}
	return "", false
}

func durableEventPayload(ev EngagementEvent) map[string]interface{} {
	payload := make(map[string]interface{}, len(ev.Payload)+5)
	for key, value := range ev.Payload {
		payload[key] = value
	}
	payload["campaign_id"] = ev.CampaignID
	payload["link_url"] = ev.LinkURL
	payload["event_type"] = ev.EventType
	payload["at"] = ev.At
	if _, ok := payload["event_name"]; !ok {
		payload["event_name"] = eventName(ev)
	}
	return payload
}
