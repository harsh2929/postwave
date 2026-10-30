// SPDX-License-Identifier: AGPL-3.0-only
//
// automation_forward.go — SUB-136 lifecycle-stage automation triggers.
//
// When a PUT /api/v1/subscribers/{id}/lifecycle actually changes the
// subscriber's lifecycle stage (Upsert returns Transitioned=true), the handler
// forwards a canonical "subscriber_lifecycle_stage_changed" event to the
// automation runtime's /v1/automations/event endpoint. The runtime matches it
// against every active automation whose trigger is keyed on the lifecycle stage
// (optionally narrowed by from_stage/to_stage) and fires the entry node — e.g.
// an opportunity → customer transition fires an onboarding sequence.
//
// The lifecycle transaction appends an opaque outbox intent. Delivery happens
// after commit with bounded retries and DLQ visibility; transport failures are
// returned to the outbox worker and never silently acknowledged.
package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// LifecycleStageChangedEvent is the canonical event_type forwarded to the
// automation runtime on a lifecycle-stage transition. Must match
// canonical.TriggerLifecycleStageChanged in the automation service.
const LifecycleStageChangedEvent = "subscriber_lifecycle_stage_changed"

// defaultLifecycleForwardHTTPClient bounds each outbox delivery attempt so a
// hung automation service cannot pin a worker indefinitely.
var defaultLifecycleForwardHTTPClient = &http.Client{Timeout: 10 * time.Second}

// AutomationForwarder forwards a lifecycle-stage transition to the automation
// runtime. The production implementation is invoked by AutomationOutboxHandler.
type AutomationForwarder interface {
	// ForwardLifecycleStageChanged forwards one transition. Any error asks the
	// outbox worker to retry or ultimately expose the event through its DLQ.
	ForwardLifecycleStageChanged(ctx context.Context, ev LifecycleStageEvent) error
}

// LifecycleStageEvent is the import-free transition payload the forwarder
// serialises onto the automation event envelope.
type LifecycleStageEvent struct {
	TenantID           string
	SubscriberID       string
	SubscriberEmail    string
	FromStage          string
	ToStage            string
	Score              int
	At                 time.Time
	SourceEventID      string
	TransitionSequence int64
}

type lifecycleAutomationPayload struct {
	SubscriberID       string    `json:"subscriber_id"`
	FromStage          string    `json:"from_stage"`
	ToStage            string    `json:"to_stage"`
	Score              int       `json:"score"`
	At                 time.Time `json:"at"`
	TransitionSequence int64     `json:"transition_sequence"`
}

// AutomationOutboxHandler resolves the current subscriber address only when
// the durable intent is delivered. The payload therefore retains no direct
// contact PII, and a subscriber erased before delivery is safely skipped.
type AutomationOutboxHandler struct {
	Repo      *Repo
	Forwarder AutomationForwarder
}

func (h *AutomationOutboxHandler) Handle(ctx context.Context, event outbox.Event) error {
	if event.Kind != AutomationOutboxKind {
		return errors.New("lifecycle automation handler received an unexpected outbox kind")
	}
	if h == nil || h.Repo == nil || h.Forwarder == nil {
		return errors.New("lifecycle automation handler is not configured")
	}
	if _, err := uuid.Parse(event.TenantID); err != nil {
		return errors.New("lifecycle automation event has an invalid tenant identity")
	}
	if _, err := uuid.Parse(event.ID); err != nil {
		return errors.New("lifecycle automation event has an invalid event identity")
	}
	var payload lifecycleAutomationPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return errors.New("lifecycle automation event has an invalid payload")
	}
	if _, err := uuid.Parse(payload.SubscriberID); err != nil ||
		!IsValidStage(payload.ToStage) ||
		(payload.FromStage != "" && !IsValidStage(payload.FromStage)) ||
		payload.FromStage == payload.ToStage || payload.Score < 1 || payload.Score > 5 ||
		payload.At.IsZero() || payload.TransitionSequence <= 0 {
		return errors.New("lifecycle automation event failed validation")
	}
	email, err := h.Repo.ResolveEmail(ctx, event.TenantID, payload.SubscriberID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("resolve lifecycle automation subscriber: %w", err)
	}
	return h.Forwarder.ForwardLifecycleStageChanged(ctx, LifecycleStageEvent{
		TenantID:           event.TenantID,
		SubscriberID:       payload.SubscriberID,
		SubscriberEmail:    email,
		FromStage:          payload.FromStage,
		ToStage:            payload.ToStage,
		Score:              payload.Score,
		At:                 payload.At,
		SourceEventID:      "lifecycle-outbox:" + event.ID,
		TransitionSequence: payload.TransitionSequence,
	})
}

// HTTPAutomationForwarder POSTs the canonical lifecycle event envelope to the
// automation runtime's /v1/automations/event endpoint. The zero value is unsafe
// (BaseURL must be set); main.go wires BaseURL + InternalAPIToken from config.
type HTTPAutomationForwarder struct {
	// BaseURL is the automation service base (cfg.AutomationServiceURL). Empty is
	// an unavailable dependency, not success, so durable intents are not dropped.
	BaseURL string
	// NotDeployed says this environment runs no automation service at all
	// (AUTOMATION_SERVICE_URL=disabled, config.ServiceNotDeployed). An intent is
	// then acknowledged without delivery: nothing here could act on it, and a
	// retry cannot change that, so failing it only walked every stage change
	// through ten logged attempts into the dead-letter queue. Without it, an
	// empty BaseURL still fails closed.
	NotDeployed bool
	// InternalAPIToken, when set, is sent as a Bearer token so the internal
	// endpoint can authenticate the gateway.
	InternalAPIToken string
	// HTTPClient is optional; nil falls back to defaultLifecycleForwardHTTPClient.
	HTTPClient *http.Client
}

// ForwardLifecycleStageChanged builds the canonical envelope the automation
// runtime's EventDispatcher decodes (EngagementEvent shape) and POSTs it. The
// transition stages ride on the payload under both name conventions
// (to_stage/stage, from_stage/previous_stage) so the runtime matcher resolves
// either. Configuration, transport, and non-success response errors are
// returned so the durable worker can retry them.
func (f *HTTPAutomationForwarder) ForwardLifecycleStageChanged(ctx context.Context, ev LifecycleStageEvent) error {
	if f != nil && f.NotDeployed {
		return nil
	}
	if f == nil || strings.TrimSpace(f.BaseURL) == "" {
		return errors.New("lifecycle automation service URL is not configured")
	}
	if _, err := uuid.Parse(ev.TenantID); err != nil {
		return errors.New("lifecycle automation forward event has an invalid tenant identity")
	}
	if _, err := uuid.Parse(ev.SubscriberID); err != nil ||
		strings.TrimSpace(ev.SourceEventID) == "" || ev.TransitionSequence <= 0 ||
		!IsValidStage(ev.ToStage) ||
		(ev.FromStage != "" && !IsValidStage(ev.FromStage)) ||
		ev.FromStage == ev.ToStage || ev.Score < 1 || ev.Score > 5 || ev.At.IsZero() {
		return errors.New("lifecycle automation forward event failed validation")
	}
	url, err := automationclient.EventURL(f.BaseURL)
	if err != nil {
		return err
	}
	at := ev.At
	envelope := map[string]any{
		"tenant_id":           ev.TenantID,
		"subscriber_id":       ev.SubscriberID,
		"subscriber_email":    ev.SubscriberEmail,
		"event_type":          LifecycleStageChangedEvent,
		"transition_sequence": ev.TransitionSequence,
		"at":                  at,
		"payload": map[string]any{
			"event_name":          LifecycleStageChangedEvent,
			"to_stage":            ev.ToStage,
			"stage":               ev.ToStage,
			"from_stage":          ev.FromStage,
			"previous_stage":      ev.FromStage,
			"score":               ev.Score,
			"transition_sequence": ev.TransitionSequence,
		},
	}
	if sourceEventID := strings.TrimSpace(ev.SourceEventID); sourceEventID != "" {
		envelope["source_event_id"] = sourceEventID
	}
	buf, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	client := f.HTTPClient
	if client == nil {
		client = defaultLifecycleForwardHTTPClient
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if sourceEventID := strings.TrimSpace(ev.SourceEventID); sourceEventID != "" {
		req.Header.Set("Idempotency-Key", sourceEventID)
	}
	if token := strings.TrimSpace(f.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("lifecycle automation endpoint returned HTTP %d", resp.StatusCode)
	}
	return nil
}
