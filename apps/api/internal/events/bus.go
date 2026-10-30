// SPDX-License-Identifier: AGPL-3.0-only
//
// Package events implements an in-process pub/sub broker for the realtime
// SSE event bus exposed at GET /api/v1/events. The bus multiplexes domain
// events (campaign.*, subscriber.*, approval.*, audit.*) to all open
// desktop/mobile SSE clients on the same Moosewave gateway instance.
//
// Multi-replica deployments: the in-memory broker (MemBackend) handles
// single-replica deploys; multi-replica deploys plug a RedisBackend
// (see redis_bus.go) into the Bus via SetBackend so events emitted on
// one replica reach SSE subscribers connected to another. The Bus's
// public API (Publish + Subscribe + Unsubscribe) is unchanged across
// backends — call sites stay cheap and side-effect free.
package events

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// Event is the wire payload pushed to subscribers. Topic uses dot.notation
// (e.g. "campaign.created", "subscriber.added"). TenantID is required —
// the SSE handler filters every delivery so cross-tenant leaks are
// impossible at the bus layer.
//
// Payload is JSON-marshalled by the SSE handler at flush time; keep it
// pointer-free + small (a domain id, status, and a label is plenty).
type Event struct {
	ID       string         `json:"id,omitempty"`
	Topic    string         `json:"topic"`
	TenantID string         `json:"tenant_id"`
	At       time.Time      `json:"at"`
	Payload  map[string]any `json:"payload,omitempty"`
}

// Subscriber is one open SSE connection. Patterns is the set of topic
// globs the client passed via ?topics=... — supports trailing `*` (e.g.
// "campaign.*") and exact matches. TenantID gates delivery; the bus
// never fans out to a different tenant.
//
// Ch is a buffered channel (capacity = subscriberBuffer). When full,
// the bus drops the message and increments Dropped — slow consumers
// don't back-pressure publishers. The desktop wrapper auto-reconnects
// on stream errors so a dropped event is recoverable via the next
// snapshot the page fetches.
type Subscriber struct {
	ID       uint64
	TenantID string
	Patterns []string
	Ch       chan Event
	Dropped  atomic.Uint64

	// UserID + UserLabel are populated by the SSE handler from
	// middleware.UserFromContext at subscribe time. The presence tracker
	// reads these to surface real identities in presence.update events
	// (instead of the legacy "user-N" placeholders). Both may be empty in
	// dev-mode where the tenant is resolved without an attached user.
	UserID    string
	UserLabel string

	// EntityRef, when non-empty, scopes this connection to a specific record
	// (e.g. "campaign:abc123") so the presence tracker can surface "who is
	// viewing THIS record" (SHELL-036) in addition to the workspace-global
	// count. Set by the SSE handler from the `entity` query param. The value
	// is opaque to the bus.
	EntityRef string
}

const subscriberBuffer = 64

// Bus is the in-process broker. Concurrency-safe; the zero value is NOT
// usable — call NewBus() so the subscriber map is initialised.

type Bus struct {
	mu          sync.RWMutex
	subscribers map[uint64]*Subscriber
	nextID      atomic.Uint64

	// hooks fire on add/remove so the presence tracker can keep its
	// per-tenant connection counts up to date without polling. A nil
	// hooks slice is fine; the bus is usable on its own.
	hookMu       sync.RWMutex
	hooks        []SubscriberHook
	publishHooks []PublishHook

	// backend is the cross-replica relay. Defaults to MemBackend (in-
	// process only); main.go installs a RedisBackend at startup when
	// REDIS_URL is set. See Backend interface below.
	backend Backend
}

// SubscriberHook is invoked synchronously inside Subscribe / Unsubscribe.
// Implementations must NOT call back into Bus methods that take the
// write lock or they will deadlock — inspection of the *Subscriber is
// fine.
type SubscriberHook interface {
	OnSubscribe(s *Subscriber)
	OnUnsubscribe(s *Subscriber)
}

// PublishHook is invoked once per Publish() call before fan-out. The
// log writer (log.go) registers as a PublishHook to persist every
// event for cursor replay. Hooks run synchronously in the publish
// path so a slow hook back-pressures publishers — keep implementations
// non-blocking (the LogWriter's Postgres insert is fast enough).
//
// Errors are intentionally not propagated — the live fan-out is the
// primary contract; persistence is best-effort.
type PublishHook interface {
	OnPublish(ctx context.Context, evt Event)
}

// NewBus returns an initialised broker. The default backend is the in-
// process MemBackend; main.go can swap it via SetBackend when REDIS_URL
// is configured.
func NewBus() *Bus {
	b := &Bus{subscribers: make(map[uint64]*Subscriber)}
	b.backend = &MemBackend{Bus: b}
	return b
}

// Backend is the pluggable cross-replica relay for the bus. The default
// MemBackend delivers entirely in-process; RedisBackend (in
// redis_bus.go) fans events out to siblings via Redis pub/sub.
//
// Implementations must:
//   - Publish: durably hand the event to whatever transport they own;
//     local fan-out is the *Bus's job (deliverLocal). For MemBackend
//     this is just deliverLocal; for RedisBackend it's PUBLISH +
//     deliverLocal.
//   - Start: begin any background relay (e.g. SUBSCRIBE goroutines)
//     and call b.deliverLocal for every inbound event from a peer.
//   - Stop: cleanly tear that relay down.
type Backend interface {
	Publish(evt Event) error
	Start() error
	Stop() error
}

// MemBackend is the trivial backend: Publish only delivers locally; no
// cross-replica fan-out. It's the default so single-replica deploys and
// every test "just works" without wiring Redis.
type MemBackend struct {
	Bus *Bus
}

// Publish on MemBackend delivers entirely in-process via deliverLocal.
func (m *MemBackend) Publish(evt Event) error {
	if m == nil || m.Bus == nil {
		return nil
	}
	m.Bus.deliverLocal(evt)
	return nil
}

// Start is a no-op for MemBackend.
func (m *MemBackend) Start() error { return nil }

// Stop is a no-op for MemBackend.
func (m *MemBackend) Stop() error { return nil }

// SetBackend swaps the cross-replica relay. main.go calls this once
// during startup if REDIS_URL is set; otherwise the MemBackend default
// stays in place. Calls AFTER bus is in active use are not safe — wire
// once during startup.
func (b *Bus) SetBackend(backend Backend) {
	if b == nil || backend == nil {
		return
	}
	b.backend = backend
}

// Backend returns the currently-installed Backend. Useful for tests +
// startup logging.
func (b *Bus) Backend() Backend {
	if b == nil {
		return nil
	}
	return b.backend
}

// AddHook registers a SubscriberHook. Hooks fire in registration order.
// Safe to call concurrently with Publish/Subscribe.
func (b *Bus) AddHook(h SubscriberHook) {
	b.hookMu.Lock()
	b.hooks = append(b.hooks, h)
	b.hookMu.Unlock()
}

// Subscribe registers a subscriber for the given tenant + topic patterns
// and returns the *Subscriber the SSE handler reads from. The caller is
// expected to hand back the Subscriber to Unsubscribe when the
// connection closes (defer in the handler).
//
// Patterns are normalised on entry: empty entries are dropped, and a
// missing patterns slice falls back to "*" (subscribe to everything in
// the tenant). Trailing `*` enables prefix matching; everything else is
// exact-equality.
//
// Use SubscribeAs when you have a resolved user identity from
// middleware.UserFromContext — the presence tracker reads UserID +
// UserLabel off the *Subscriber to label live collaborators in
// presence.update events.
func (b *Bus) Subscribe(tenantID string, patterns []string) *Subscriber {
	return b.SubscribeAs(tenantID, "", "", patterns)
}

// SubscribeAs is the identity-aware companion to Subscribe. Pass the
// resolved (userID, userLabel) so the presence tracker can render real
// identities. Either argument may be empty; the tracker falls back to a
// stable per-connection placeholder for the missing pieces.
func (b *Bus) SubscribeAs(tenantID, userID, userLabel string, patterns []string) *Subscriber {
	return b.SubscribeAsEntity(tenantID, userID, userLabel, "", patterns)
}

// SubscribeAsEntity is SubscribeAs plus a per-record scope (SHELL-036). A
// non-empty entityRef makes the presence tracker also count this connection
// under that record so detail pages can show who else is viewing it. entityRef
// "" behaves exactly like SubscribeAs.
func (b *Bus) SubscribeAsEntity(tenantID, userID, userLabel, entityRef string, patterns []string) *Subscriber {
	patterns = normalizePatterns(patterns)
	s := &Subscriber{
		ID:        b.nextID.Add(1),
		TenantID:  tenantID,
		Patterns:  patterns,
		Ch:        make(chan Event, subscriberBuffer),
		UserID:    userID,
		UserLabel: userLabel,
		EntityRef: entityRef,
	}
	b.mu.Lock()
	b.subscribers[s.ID] = s
	b.mu.Unlock()

	for _, h := range b.subscriberHooks() {
		runSubscriberHook("OnSubscribe", s, h.OnSubscribe)
	}
	return s
}

// Unsubscribe removes a subscriber and closes its channel. Idempotent —
// calling twice is safe (the second call is a no-op).
func (b *Bus) Unsubscribe(s *Subscriber) {
	if s == nil {
		return
	}
	b.mu.Lock()
	_, present := b.subscribers[s.ID]
	if present {
		delete(b.subscribers, s.ID)
	}
	b.mu.Unlock()
	if !present {
		return
	}
	// Closing here is safe because deliverLocal only sends while holding
	// b.mu for reading, and only to subscribers still in the map. Taking the
	// write lock above waited out every delivery that could have chosen s,
	// and the delete means no later delivery can choose it.
	close(s.Ch)

	// Every hook is cleanup for a connection that is already gone, so one
	// failing must not skip the rest: runSubscriberHook contains each.
	for _, h := range b.subscriberHooks() {
		runSubscriberHook("OnUnsubscribe", s, h.OnUnsubscribe)
	}
}

// subscriberHooks snapshots the registered hooks so they run without
// hookMu held (a hook may publish, and Publish must not wait on AddHook).
func (b *Bus) subscriberHooks() []SubscriberHook {
	b.hookMu.RLock()
	defer b.hookMu.RUnlock()
	return append([]SubscriberHook(nil), b.hooks...)
}

// runSubscriberHook calls one hook and contains a panic from it. Hooks run on
// the SSE request goroutine, often from its deferred Unsubscribe; a panic that
// escaped would skip every later hook (leaving, for example, the presence
// tracker counting a connection that has closed) and turn a finished stream
// into a crashed request. The failure is logged with its stack at ERROR so it
// is still loud.
func runSubscriberHook(phase string, s *Subscriber, fn func(*Subscriber)) {
	defer func() {
		if r := recover(); r != nil {
			slog.Default().Error("events: subscriber hook panicked",
				"phase", phase,
				"sub_id", s.ID,
				"tenant_id", s.TenantID,
				"panic", fmt.Sprint(r),
				"stack", string(debug.Stack()))
		}
	}()
	fn(s)
}

// Publish fans out evt to every subscriber whose tenant matches and at
// least one pattern matches the topic. Slow consumers (full channel)
// have the message dropped; the per-subscriber Dropped counter ticks so
// operators can spot consistently lossy clients.
//
// Publish never blocks longer than the time to traverse the subscriber
// map. The send-or-drop loop is non-blocking by construction.
//
// Publish delegates to the installed Backend. The default MemBackend
// just calls deliverLocal; a RedisBackend additionally PUBLISHes the
// event so siblings on other replicas pick it up via SUBSCRIBE.
func (b *Bus) Publish(evt Event) {
	if evt.ID == "" {
		evt.ID = uuid.NewString()
	}
	if evt.At.IsZero() {
		evt.At = time.Now().UTC()
	}
	if evt.TenantID == "" {
		// Tenant-less events would leak across tenants if any subscriber
		// matched the topic — refuse to publish them. Caller bug.
		return
	}
	// Persistence + audit hooks fire BEFORE backend fan-out so a
	// downstream consumer reading from the log can't get a sequence_id
	// ahead of an event that hasn't been persisted yet.
	b.mu.RLock()
	hooks := append([]PublishHook(nil), b.publishHooks...)
	b.mu.RUnlock()
	for _, h := range hooks {
		// We don't pass a request context here — hooks run on the
		// publisher's goroutine. context.Background is fine; the
		// LogWriter applies its own timeout.
		h.OnPublish(context.Background(), evt)
	}
	if b.backend != nil {
		_ = b.backend.Publish(evt)
		return
	}
	b.deliverLocal(evt)
}

// AddPublishHook installs a PublishHook. Hooks fire in registration
// order on every Publish() before backend fan-out.
func (b *Bus) AddPublishHook(h PublishHook) {
	if h == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.publishHooks = append(b.publishHooks, h)
}

// deliverLocal fans the event out to every locally-attached subscriber.
// Backend implementations call this for events that arrived from a
// peer (e.g. RedisBackend's SUBSCRIBE goroutine) so the subscriber-
// matching logic stays in one place.
//
// The sends happen while b.mu is held for reading. That is the invariant
// Unsubscribe relies on to close a channel safely: it removes the
// subscriber under the write lock, so it cannot proceed to close(s.Ch)
// until every delivery that saw s has finished sending. Copying the
// targets and sending after RUnlock (as this once did) left a window in
// which a concurrent Unsubscribe closed a target's channel and the send
// panicked with "send on closed channel". Holding the read lock costs
// nothing extra: each send is non-blocking, and concurrent deliveries
// share the read lock.
func (b *Bus) deliverLocal(evt Event) {
	if b == nil {
		return
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.subscribers {
		if s.TenantID != evt.TenantID {
			continue
		}
		if !matchAny(s.Patterns, evt.Topic) {
			continue
		}
		select {
		case s.Ch <- evt:
		default:
			s.Dropped.Add(1)
		}
	}
}

// SubscriberCount returns the number of currently-connected subscribers
// for a tenant. Used by the presence tracker.
func (b *Bus) SubscriberCount(tenantID string) int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	n := 0
	for _, s := range b.subscribers {
		if s.TenantID == tenantID {
			n++
		}
	}
	return n
}

// matchAny returns true when topic matches any pattern in patterns.
// "*" matches anything; "prefix.*" matches topics with that prefix;
// otherwise exact equality.
func matchAny(patterns []string, topic string) bool {
	for _, p := range patterns {
		if matchOne(p, topic) {
			return true
		}
	}
	return false
}

func matchOne(pattern, topic string) bool {
	if pattern == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, ".*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(topic, prefix)
	}
	return pattern == topic
}

func normalizePatterns(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	sawInput := false
	for _, p := range in {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		sawInput = true
		if len(p) > maxStreamTopicBytes || !streamTopicRE.MatchString(p) {
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
		if sawInput {
			return []string{noMatchTopic()}
		}
		return []string{"*"}
	}
	return out
}
