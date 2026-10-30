// SPDX-License-Identifier: AGPL-3.0-only

package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// FanoutKind is the outbox row kind used by sibling services to ask the
// API gateway to dispatch an event to all matching webhook subscriptions.
//
// Why this exists: services/* are separate Go modules and cannot import
// apps/api/internal/webhooks. They CAN write to the shared outbox table
// (it's just Postgres), so we let them write a "please fan out" row and
// register a handler here that resolves it. That handler runs inside
// the existing outbox worker so retries + DLQ + lease semantics come
// for free, same as direct deliveries.
//
// Producers should write a single fanout row per event; FanoutHandler
// expands that into N webhooks.deliver rows (one per matching tenant
// subscription) by calling Dispatcher.Fire on the worker tx. From the
// outbox's perspective the fanout row succeeds as soon as the per-
// subscription deliver rows are enqueued — actual HTTP delivery
// retries happen on those child rows.
const FanoutKind = "webhook.fanout"

// FanoutPayload is the JSON shape services write into outbox_events.
// Mirrors FireInput; named separately because services should treat
// this as a stable wire contract — renaming FireInput shouldn't break
// already-queued rows.
type FanoutPayload struct {
	EventType      string          `json:"event_type"`
	Body           json.RawMessage `json:"body"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
}

// FanoutHandler is registered with the outbox worker against FanoutKind.
//
// It re-enters the dispatcher inside a fresh tenant-scoped tx — the
// outbox worker hands us TenantID via ev.TenantID and gives us a
// tenant-isolated read of webhook subscriptions, exactly as if we
// were inside the original producer's write tx.
//
// One nuance: the original producer's row already committed by the
// time we run, so atomicity-with-business-write is weaker for
// cross-service events than for in-process Fires. That's fine for
// terminal events (a finished migration, a generated sequence) where
// the business state is durably committed before fanout — there's no
// world where the fanout fires for a state that didn't happen.
type FanoutHandler struct {
	Pool       *db.Pool
	Dispatcher *Dispatcher
	// IntegrationFanouts is a slice of optional per-integration
	// adapters (Slack, Discord, Teams, …) called inside the same
	// tenant tx as the webhooks Dispatcher fanout. Each adapter
	// writes its own outbox rows; their outbox handlers run independently.
	//
	// Defined as an interface slice so this package doesn't import
	// internal/slackint etc. — those depend on webhooks (OutboxKind
	// pattern); a back-edge would cycle.
	IntegrationFanouts []IntegrationFanouter

	// SlackFanout is the original single-adapter slot, kept for
	// backward compatibility. Honoured alongside IntegrationFanouts
	// when both are set.
	SlackFanout IntegrationFanouter

	// OperatorNotify is the OPTIONAL first-party half of a cross-service
	// event (AUTOMATION#41).
	//
	// Everything else on this handler delivers to a destination the TENANT
	// configured: a webhook subscription, a Slack workspace, a Teams channel.
	// That means a sibling service's alert reaches a human only if somebody
	// built an integration to receive it — which for an operational alert
	// ("participants have stopped moving through this journey") is exactly
	// backwards. This slot lets main.go route a bounded set of cross-service
	// events onto the first-party notification chokepoint as well, so the alert
	// reaches the team's own feed, browsers and phones.
	//
	// nil is a no-op, and it is deliberately consulted AFTER the tenant tx
	// commits: a notification about a fanout that rolled back is a lie.
	OperatorNotify CrossServiceNotifier
}

// CrossServiceNotifier receives cross-service fanout events for first-party
// operator notification.
//
// Declared over primitives, and over the RAW body rather than a parsed shape,
// for the same reason auditsink's CircuitNotifier is: this package must not
// learn about internal/notifyfanout (a back-edge would cycle) and must not
// learn the payload schema of every sibling service. main.go owns both — it
// decides which event types are notification-worthy and how to read them, and
// an event it does not recognise costs nothing here.
//
// Returns nothing: the fanout has already committed by the time it is called,
// and failing to announce a delivered event must never fail the delivery.
type CrossServiceNotifier interface {
	NotifyCrossServiceEvent(ctx context.Context, tenantID, eventType string, body json.RawMessage)
}

// IntegrationFanouter is the narrow interface for per-integration
// fanout adapters (Slack, Discord, Teams, ...). Each integration's
// Dispatcher.Fire signature satisfies this contract.
type IntegrationFanouter interface {
	Fire(ctx context.Context, tx pgx.Tx, tenantID, eventType string, body any) (int, error)
}

// SlackFanouter is the legacy alias; new code uses IntegrationFanouter.
type SlackFanouter = IntegrationFanouter

// Handle implements outbox.HandlerFunc.
func (h *FanoutHandler) Handle(ctx context.Context, ev outbox.Event) error {
	if h == nil || h.Pool == nil || h.Dispatcher == nil {
		return errors.New("webhooks: FanoutHandler not configured")
	}
	var p FanoutPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		// Bad payload: returning a non-nil error retries up to MaxAttempts
		// then DLQs. We don't try to recover.
		return fmt.Errorf("webhooks fanout: malformed payload: %w", err)
	}
	if !IsValidEvent(p.EventType) {
		// Unknown event type — DLQ rather than fan out empty queries.
		// The producer should have validated upstream; surface here
		// loudly via the error log.
		return fmt.Errorf("webhooks fanout: unknown event %q", p.EventType)
	}
	tx, err := db.WithTenant(ctx, h.Pool, ev.TenantID)
	if err != nil {
		return fmt.Errorf("webhooks fanout: begin tenant tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := h.Dispatcher.Fire(ctx, tx, FireInput{
		TenantID:       ev.TenantID,
		EventType:      EventType(p.EventType),
		Body:           json.RawMessage(p.Body),
		IdempotencyKey: p.IdempotencyKey,
	}); err != nil {
		return fmt.Errorf("webhooks fanout: dispatch: %w", err)
	}
	// Per-integration fanouts (Slack / Discord / Teams / future). Each
	// runs in the same tenant tx so a multi-integration tenant gets
	// atomic delivery across all channels — either every adapter's
	// outbox row commits or none of them do.
	body := json.RawMessage(p.Body)
	if h.SlackFanout != nil {
		if _, err := h.SlackFanout.Fire(ctx, tx, ev.TenantID, p.EventType, body); err != nil {
			return fmt.Errorf("webhooks fanout: slack dispatch: %w", err)
		}
	}
	for _, adapter := range h.IntegrationFanouts {
		if adapter == nil {
			continue
		}
		if _, err := adapter.Fire(ctx, tx, ev.TenantID, p.EventType, body); err != nil {
			return fmt.Errorf("webhooks fanout: integration dispatch: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// First-party operator notification, AFTER the commit. Outbox delivery is
	// at-least-once, so this can run more than once for one logical alert; the
	// notifier is responsible for its own dedup identity (notifyfanout's
	// DedupeKey), which is the right place for it — the same alert re-emitted
	// by a producer restart has to collapse too, and this handler cannot see
	// that.
	if h.OperatorNotify != nil {
		h.OperatorNotify.NotifyCrossServiceEvent(ctx, ev.TenantID, p.EventType, body)
	}
	return nil
}

// FanoutAppender is the small interface any package can satisfy to
// queue a fanout row. Lives here so services don't have to know about
// outbox.Append's full shape — just hand us tenant + event + body.
//
// The default implementation lives in main.go (uses *outbox.Repo) so
// the dependency points the right way: the producer side doesn't link
// against outbox internals.
type FanoutAppender interface {
	AppendFanout(ctx context.Context, tenantID, eventType string, body any) error
}
