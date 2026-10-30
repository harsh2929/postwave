// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

const (
	maxStreamTopicCount    = 50
	maxStreamTopicCSVBytes = 1024
	maxStreamTopicBytes    = 128
)

// streamTopicRE is the grammar for a client-supplied `?topics=` filter entry.
//
// Segments allow `_` because published topic names use it: `list_health.degraded`
// (deliverability_hub), `subscriber.engagement_updated` (SUB-096's live counter),
// `subscriber.lifecycle_stage_changed`, `subscriber.pii_detected`, and others.
// Without it those filters were silently DISCARDED by parseTopics — a client
// asking for a real topic by name got no event and no error, and the web
// dashboard's concrete `subscriber.lifecycle_stage_changed` subscription never
// matched anything. Underscores cannot widen the match: matchOne compares
// against the pattern trimmed to its trailing dot, so `list_health.*` and
// `list.*` remain disjoint despite the shared textual prefix.
var streamTopicRE = regexp.MustCompile(`^(\*|[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*(\.\*)?)$`)

// Handler is the SSE handler factory mounted on /api/v1/events. It
// closes over the Bus so all replicas of the route share the same
// in-process broker.
//
// Wire format (mirrors apps/api/internal/analytics/dashboard_live.go):
//
//	event: campaign.created
//	data: {"topic":"campaign.created","tenant_id":"...","at":"...","payload":{...}}
//
//	:keepalive
//
//	event: subscriber.added
//	data: {...}
//
// Auth is enforced upstream — this handler runs inside the same protected
// chi group as /dashboard/live, which means TenantMiddleware has already
// resolved the tenant. The api-keys middleware accepts ?api_key= as a
// fallback so EventSource (which can't set headers) works.
//
// Tenant isolation: TenantFromContext is the *only* source of truth for
// the bus subscription tenant. The handler never reads tenant from the
// query string. Cross-tenant leak is not possible because Publish filters
// on TenantID inside the bus itself.
type HandlerDeps struct {
	Bus *Bus
	// HeartbeatInterval — how often to emit `:keepalive\n\n`. Default 30s
	// (matches dashboard_live.go).
	HeartbeatInterval time.Duration
	// MaxDuration caps the wall-clock lifetime of a single connection
	// to bound idle-goroutine count. Default 5min; the desktop wrapper
	// auto-reconnects so the cap is invisible to operators.
	MaxDuration time.Duration
	// Logger is used for warn-level operator hints (e.g. dropped
	// messages on a slow consumer). Nil falls back to slog.Default().
	Logger *slog.Logger
}

// Handle is the http.HandlerFunc. Mounted in main.go via NewHandler.
func (d *HandlerDeps) Handle(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	filters := parseStreamFilters(r.URL.Query())
	patterns := parseTopics(r.URL.Query().Get("topics"))

	// A writer chain that cannot flush would hold the connection without ever
	// delivering an event; refuse before committing a 200.
	stream, ok := sse.Open(w)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "streaming_unsupported", "this response cannot be streamed")
		return
	}

	// SSE response headers — same set the dashboard live stream uses.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	heartbeat := d.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = 30 * time.Second
	}
	maxDur := d.MaxDuration
	if maxDur <= 0 {
		maxDur = 5 * time.Minute
	}
	logger := d.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Plumb the resolved user identity (if any) into the subscription so
	// the presence tracker can render real labels in presence.update
	// events. The label is the privacy-safe display form (email local-
	// part) — full emails never go on the presence wire because every
	// same-tenant session can read these payloads. Dev-mode tenant
	// resolution may leave the user nil; the tracker falls back to a
	// stable per-connection placeholder.
	userID := ""
	userLabel := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		userID = u.ID
		userLabel = presenceDisplayLabel(u)
	}
	// Optional per-record scope (SHELL-036): a detail page passes ?entity=
	// (e.g. "campaign:abc") so the presence tracker can report who else is
	// viewing THIS record. Bounded so a hostile client can't register a giant
	// key; empty = workspace-global presence only, as before.
	entityRef := strings.TrimSpace(r.URL.Query().Get("entity"))
	if len(entityRef) > 128 {
		entityRef = entityRef[:128]
	}
	sub := d.Bus.SubscribeAsEntity(t.ID, userID, userLabel, entityRef, patterns)
	defer d.Bus.Unsubscribe(sub)

	// Send a small `event: ready` so the client can flip its status
	// indicator from "connecting" -> "open" without waiting for the
	// first domain event. Mirrors the immediate snapshot pattern in
	// dashboard_live.go.
	if stream.Sendf("event: ready\ndata: %s\n\n", mustJSON(map[string]any{
		"tenant_id": t.ID,
		"topics":    patterns,
	})) != nil {
		return
	}

	heartT := time.NewTicker(heartbeat)
	defer heartT.Stop()
	deadline := time.NewTimer(maxDur)
	defer deadline.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			_ = stream.Sendf(":bye max-duration\n\n")
			return
		case <-heartT.C:
			// A failed write means the client is gone; returning releases the
			// subscription instead of heartbeating into a dead socket.
			if stream.Sendf(":keepalive\n\n") != nil {
				return
			}
		case evt, ok := <-sub.Ch:
			if !ok {
				// Bus closed our channel — peer side gone, nothing more
				// to send. Bail; the desktop wrapper reconnects.
				return
			}
			// Defensive: TenantID filter is already enforced inside the
			// bus, but a misbehaving Publish call (manually constructed
			// Event, wrong tenant) would still be caught here.
			if evt.TenantID != t.ID {
				logger.Warn("events: dropped cross-tenant event",
					"want_tenant", t.ID, "got_tenant", evt.TenantID,
					"topic", evt.Topic)
				continue
			}
			if !eventMatchesFilters(evt, filters) {
				continue
			}
			body, err := json.Marshal(eventWirePayload(evt))
			if err != nil {
				logger.Warn("events: marshal failed", "topic", evt.Topic, "err", err)
				continue
			}
			if stream.Sendf("event: %s\ndata: %s\n\n", evt.Topic, body) != nil {
				return
			}
			if dropped := sub.Dropped.Load(); dropped > 0 && dropped%64 == 1 {
				// Periodic operator hint that *this* subscriber is
				// shedding events. The %64 throttle keeps the log line
				// from spamming on a wedged client.
				logger.Warn("events: subscriber dropping events",
					"sub_id", sub.ID, "tenant", sub.TenantID, "dropped", dropped)
			}
		}
	}
}

// NewHandler returns an http.HandlerFunc bound to bus with default
// timing knobs. Tests construct HandlerDeps directly for tighter caps.
func NewHandler(bus *Bus) http.HandlerFunc {
	d := &HandlerDeps{Bus: bus}
	return d.Handle
}

type streamFilters struct {
	EventTypes      []string
	CampaignID      string
	SubscriberEmail string
}

func parseStreamFilters(q url.Values) streamFilters {
	return streamFilters{
		EventTypes:      parseTopics(q.Get("event_type")),
		CampaignID:      strings.TrimSpace(firstNonEmpty(q.Get("campaign"), q.Get("campaign_id"))),
		SubscriberEmail: strings.ToLower(strings.TrimSpace(q.Get("subscriber_email"))),
	}
}

func parseTopics(csv string) []string {
	csv = strings.TrimSpace(csv)
	if csv == "" {
		return []string{"*"}
	}
	if len(csv) > maxStreamTopicCSVBytes {
		return []string{noMatchTopic()}
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || len(p) > maxStreamTopicBytes || !streamTopicRE.MatchString(p) {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
		if len(out) >= maxStreamTopicCount {
			break
		}
	}
	if len(out) == 0 {
		return []string{noMatchTopic()}
	}
	return out
}

func noMatchTopic() string {
	return "__postwave_no_match__"
}

func eventMatchesFilters(evt Event, filters streamFilters) bool {
	if len(filters.EventTypes) > 0 && !matchesAny(filters.EventTypes, eventTypeOf(evt)) {
		return false
	}
	if filters.CampaignID != "" && payloadString(evt.Payload, "campaign_id") != filters.CampaignID {
		return false
	}
	if filters.SubscriberEmail != "" && strings.ToLower(payloadString(evt.Payload, "subscriber_email")) != filters.SubscriberEmail {
		return false
	}
	return true
}

func matchesAny(patterns []string, value string) bool {
	if value == "" {
		return false
	}
	for _, p := range patterns {
		if p == "*" || p == value {
			return true
		}
		if strings.HasSuffix(p, "*") && strings.HasPrefix(value, strings.TrimSuffix(p, "*")) {
			return true
		}
	}
	return false
}

func eventTypeOf(evt Event) string {
	if v := payloadString(evt.Payload, "event_type"); v != "" {
		return v
	}
	return evt.Topic
}

func eventWirePayload(evt Event) map[string]any {
	out := map[string]any{
		"topic":      evt.Topic,
		"event_type": eventTypeOf(evt),
		"tenant_id":  evt.TenantID,
		"at":         evt.At,
		"ts":         evt.At.Format(time.RFC3339Nano),
		"payload":    evt.Payload,
	}
	for _, key := range []string{"campaign_id", "subscriber_email", "subscriber_id"} {
		if v := payloadString(evt.Payload, key); v != "" {
			out[key] = v
		}
	}
	return out
}

func payloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	v, ok := payload[key]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	default:
		return fmt.Sprint(typed)
	}
}

type subscribeRequest struct {
	EventTypes      []string `json:"event_types"`
	CampaignID      string   `json:"campaign_id"`
	SubscriberEmail string   `json:"subscriber_email"`
}

// SubscribeHandler returns a small declarative subscription descriptor for
// SDKs and agents. The stream remains SSE-backed and stateless; this endpoint
// validates the requested filters and returns the canonical resource URI a
// client should connect to.
func SubscribeHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := middleware.TenantFromContext(r.Context()); !ok {
			writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
			return
		}
		var body subscribeRequest
		if err := httpbody.DecodeJSON(w, r, 16<<10, &body); err != nil {
			writeJSONError(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), "request body must be valid JSON")
			return
		}
		eventTypes, err := normalizeEventTypes(body.EventTypes)
		if err != nil {
			httperror.WriteValidation(w, "bad_event_types", "request payload is invalid")
			return
		}
		values := url.Values{}
		if len(eventTypes) > 0 {
			values.Set("event_type", strings.Join(eventTypes, ","))
		}
		if campaignID := strings.TrimSpace(body.CampaignID); campaignID != "" {
			values.Set("campaign", campaignID)
		}
		if email := strings.TrimSpace(body.SubscriberEmail); email != "" {
			values.Set("subscriber_email", strings.ToLower(email))
		}
		resourceURI := "/api/v1/events/stream"
		if encoded := values.Encode(); encoded != "" {
			resourceURI += "?" + encoded
		}
		writeJSON(w, http.StatusCreated, map[string]string{
			"subscription_id": "evt_sub_" + randomHex(12),
			"resource_uri":    resourceURI,
		})
	}
}

func normalizeEventTypes(in []string) ([]string, error) {
	if len(in) > 20 {
		return nil, fmt.Errorf("at most 20 event_types are allowed")
	}
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, raw := range in {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		if len(v) > 128 {
			return nil, fmt.Errorf("event_type %q is too long", v)
		}
		for _, ch := range v {
			if !(ch == '.' || ch == '_' || ch == '-' || ch == '*' || ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z') {
				return nil, fmt.Errorf("event_type %q contains unsupported characters", v)
			}
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out, nil
}

func randomHex(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// The values we marshal here are static maps; any error is a
		// programmer mistake. Return an empty object as a defensive
		// fallback rather than panic mid-handler.
		return []byte("{}")
	}
	return b
}

func writeJSONError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ----------------------------------------------------------------------
// Publish endpoint — POST /api/v1/events/publish
//
// Lets clients (notably the desktop CursorOverlay) emit transient,
// presence-class events to other sessions for the same tenant. The bus
// fans the message out via the existing SSE stream — no new transport.
//
// Authorization model:
//   - Only a dashboard session with a resolved user may publish. API keys are
//     intentionally rejected by the generated route policy and this handler
//     independently requires the user context before accepting a payload.
//   - Tenant scope is taken EXCLUSIVELY from the request context. The
//     body's tenant_id (if any) is ignored — a misbehaving client cannot
//     publish into a foreign tenant.
//   - Topic allow-list: only "cursor.move" and "selection.move" are
//     accepted today. Server-originated topics (campaign.*, subscriber.*,
//     audit.*, approval.*, presence.*) MUST stay server-emitted so the
//     SSE stream remains authoritative — letting clients spoof those
//     would corrupt every consuming surface.
//
// Rate limit: 20 req/sec per user via a tiny in-memory token bucket
// keyed on (tenant, user). 20 req/sec covers a 100ms-throttled cursor
// emitter with headroom for both `cursor.move` and `selection.move` on
// the same connection without triggering the limiter on a normal user.
// On overflow we 429 with a structured error so the client can drop the
// frame (cursor data is lossy by design — a missed publish just means
// the next cursor render is one frame behind).
//
// The bucket lives entirely in-process. Multi-replica deploys naturally
// share the limit per replica only; Redis-backed sliding windows are a
// future hardening if needed.
const (
	publishBucketSize    = 20
	publishBucketRefill  = time.Second
	publishMaxPayloadKiB = 8 // hard cap on payload bytes; cursor moves are tiny
)

// allowedPublishTopics is the explicit allow-list. If you add a topic
// here, double-check that a hostile client emitting it can't lie to a
// downstream surface (e.g. sending fake presence.update events would
// invalidate the presence indicator's accuracy).
var allowedPublishTopics = map[string]struct{}{
	"cursor.move":    {},
	"selection.move": {},
}

// publishLimiter is the per-(tenant,user) token bucket. We use a
// sync.Map of *publishBucket so concurrent Inc on different keys never
// contends; per-key state has its own Mutex.
type publishBucket struct {
	mu        sync.Mutex
	tokens    int
	lastReset time.Time
}

var publishLimiterState sync.Map // map[string]*publishBucket

// allowPublish returns true if the (tenant,user) tuple has at least
// one token available, decrements it, and returns. Refills bucketSize
// tokens every refillEvery interval.
func allowPublish(tenantID, userID string, now time.Time) bool {
	key := tenantID + "|" + userID
	loaded, _ := publishLimiterState.LoadOrStore(key, &publishBucket{
		tokens:    publishBucketSize,
		lastReset: now,
	})
	b := loaded.(*publishBucket)
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.Sub(b.lastReset) >= publishBucketRefill {
		b.tokens = publishBucketSize
		b.lastReset = now
	}
	if b.tokens <= 0 {
		return false
	}
	b.tokens--
	return true
}

// publishRequest is the body of POST /api/v1/events/publish.
type publishRequest struct {
	Topic   string         `json:"topic"`
	Payload map[string]any `json:"payload,omitempty"`
}

// Publish is the HTTP handler. Mounted in main.go alongside the SSE
// subscribe route.
func (d *HandlerDeps) Publish(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	u, _ := middleware.UserFromContext(r.Context())
	if u == nil || strings.TrimSpace(u.ID) == "" {
		writeJSONError(w, http.StatusUnauthorized, "no_user", "dashboard session user required")
		return
	}
	userID := u.ID
	var req publishRequest
	if err := httpbody.DecodeJSON(w, r, int64(publishMaxPayloadKiB)*1024, &req); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req.Topic = strings.TrimSpace(req.Topic)
	if req.Topic == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_topic", "topic is required")
		return
	}
	if _, ok := allowedPublishTopics[req.Topic]; !ok {
		// 403 instead of 400 so callers can distinguish "this topic
		// isn't in the schema" (client bug) from "your client lied"
		// (potential abuse / misconfig).
		writeTopicNotPublishableDenial(w)
		return
	}
	if !allowPublish(t.ID, userID, time.Now()) {
		writeJSONError(w, http.StatusTooManyRequests, "rate_limited",
			"publish rate limit exceeded (20 req/s/user)")
		return
	}
	if d.Bus == nil {
		// Honest fallback: tell the caller the publish was a no-op so
		// the client can fall back to its same-origin BroadcastChannel
		// path without thinking the publish "succeeded".
		writeJSONError(w, http.StatusServiceUnavailable, "bus_unavailable",
			"event bus not configured")
		return
	}
	// Presence identity (A27): relayed presence-class payloads carry the
	// SERVER-resolved identity, not whatever the client claimed. This is
	// the relay point — stamping here both prevents label spoofing and
	// replaces any client-side "user-NNNN" placeholder with the real
	// display label (email local-part; never the full email).
	if req.Payload == nil {
		req.Payload = map[string]any{}
	}
	req.Payload["user_id"] = u.ID
	req.Payload["user_label"] = presenceDisplayLabel(u)
	d.Bus.Publish(Event{
		Topic:    req.Topic,
		TenantID: t.ID,
		Payload:  req.Payload,
	})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"published": true,
		"topic":     req.Topic,
	})
}

// PublishHandler returns an http.HandlerFunc bound to bus, suitable for
// chi.Router.Post. Mirrors NewHandler's shape.
func PublishHandler(bus *Bus) http.HandlerFunc {
	d := &HandlerDeps{Bus: bus}
	return d.Publish
}

// writeTopicNotPublishableDenial refuses publishing to a topic clients may not
// write.
//
// ReasonPolicy with no remedy: the allow-list is a product decision about which
// topics a browser may inject events into. No role, plan or admin widens it, and
// offering any of them would send someone looking for a setting that does not
// exist.
func writeTopicNotPublishableDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "event_topic",
		Reason:  entitlement.ReasonPolicy,
		Code:    "topic_not_publishable",
		Message: "topic not in client-publishable allow-list",
	})
}
