// SPDX-License-Identifier: AGPL-3.0-only
//
// automation_forward.go — segment_joined automation triggers.
//
// When either membership-cache worker (the live SegmentEventWorker or the
// send-time materialiser) rewrites a segment and detects that a
// subscriber newly entered it (matches the predicate now, was not previously
// cached in segment_subscribers), it forwards a canonical "segment_joined"
// event to the automation runtime's /v1/automations/event endpoint. The
// runtime matches it against every active automation whose trigger is keyed on
// that segment_id (canonical.MatchSegmentJoined) and fires the entry node — the
// "Entered segment" flow trigger.
//
// The forward is best-effort + fire-and-forget: a transport failure must never
// fail the membership rewrite (already committed). Mirrors the lifecycle-stage
// forwarder (internal/lifecycle/automation_forward.go) byte-for-byte in shape.
package segments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
)

// SegmentJoinedEvent is the canonical event_type forwarded to the automation
// runtime on a segment-entry transition. Must match
// canonical.TriggerSegmentJoined in the automation service.
const SegmentJoinedEvent = "segment_joined"

// defaultSegmentForwardHTTPClient bounds the fire-and-forget forward so a hung
// automation service can never pin a goroutine indefinitely.
var defaultSegmentForwardHTTPClient = &http.Client{Timeout: 10 * time.Second}

// SegmentJoinEvent is the import-free transition payload the forwarder
// serialises onto the automation event envelope.
type SegmentJoinEvent struct {
	TenantID        string
	SubscriberEmail string
	SegmentID       string
	At              time.Time
}

// SegmentJoinForwarder forwards a segment-entry transition to the automation
// runtime. An interface so the worker is testable with a fake; the production
// implementation is *HTTPSegmentJoinForwarder, wired in main.go.
type SegmentJoinForwarder interface {
	// ForwardSegmentJoined forwards one entrant. Invoked post-commit; its
	// error is logged, never surfaced.
	ForwardSegmentJoined(ctx context.Context, ev SegmentJoinEvent) error
}

// HTTPSegmentJoinForwarder POSTs the canonical segment_joined envelope to the
// automation runtime's /v1/automations/event endpoint. An empty BaseURL
// disables forwarding (no-op), so a deployment without the automation runtime
// is unaffected.
type HTTPSegmentJoinForwarder struct {
	BaseURL          string
	InternalAPIToken string
	HTTPClient       *http.Client
}

// Enabled reports whether forwards go anywhere. Without an automation runtime
// the forwarder is a no-op, and the cache workers skip entrant detection
// rather than diff membership for events nobody receives.
func (f *HTTPSegmentJoinForwarder) Enabled() bool {
	return f != nil && strings.TrimSpace(f.BaseURL) != ""
}

// ForwardSegmentJoined builds the EngagementEvent-shaped envelope the runtime
// decodes (segment_id rides on the payload under the same key the matcher
// reads) and POSTs it. A missing BaseURL or transport error is swallowed.
func (f *HTTPSegmentJoinForwarder) ForwardSegmentJoined(ctx context.Context, ev SegmentJoinEvent) error {
	if f == nil || strings.TrimSpace(f.BaseURL) == "" {
		return nil
	}
	url, err := automationclient.EventURL(f.BaseURL)
	if err != nil {
		return err
	}
	at := ev.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	envelope := map[string]any{
		"tenant_id":        ev.TenantID,
		"subscriber_email": ev.SubscriberEmail,
		"event_type":       SegmentJoinedEvent,
		"at":               at,
		"payload": map[string]any{
			"event_name": SegmentJoinedEvent,
			"segment_id": ev.SegmentID,
		},
	}
	buf, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	client := f.HTTPClient
	if client == nil {
		client = defaultSegmentForwardHTTPClient
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(f.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	return nil
}
