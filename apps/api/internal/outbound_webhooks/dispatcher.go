// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/events"
)

// tenantCacheTTL is the per-tenant matching-webhook cache lifetime.
// The dispatcher consults this cache before hitting the DB on every
// event so a tenant with no listeners pays one cheap map lookup. The
// 60-second TTL caps the worst-case delay between "user adds a webhook"
// and "events start arriving" — short enough to feel instant in the UI.
const tenantCacheTTL = 60 * time.Second

// tenantCacheEntry is the cached lookup result for one tenant.
type tenantCacheEntry struct {
	at    time.Time
	byEvt map[string][]scopedWebhook // eventType -> matching webhooks
}

// scopedWebhook bundles the webhook id with its optional list scope
// so the dispatcher can drop list.subscriber.* events whose payload
// list_id doesn't match without hitting the DB on the hot path.
type scopedWebhook struct {
	ID     string
	ListID string // "" = tenant-wide
}

// Dispatcher is the retired compatibility fanout for callers that still use
// Dispatch directly. Production no longer registers it as an events.Bus hook:
// every public webhook topic writes its delivery intent in the same database
// transaction as the business mutation. Keeping the type temporarily avoids a
// flag-day removal for internal tests and extensions while the publish hook
// remains fail-closed for every customer-visible topic.
//
// Publish hooks run exactly once on the process that originates an event,
// before Redis relays it to SSE clients. This deliberately avoids treating an
// open dashboard SSE connection as a delivery prerequisite and avoids
// duplicate fanout when Redis echoes a publish to the originating replica.
type Dispatcher struct {
	Store *Store
	Bus   *events.Bus
	Log   *slog.Logger

	// Topics is the set of event types we care about. Defaults to
	// AllowedEvents — the Bus delivery path filters by topic so we
	// don't spend cycles on `cursor.move` etc.
	Topics []string

	cacheMu sync.RWMutex
	cache   map[string]*tenantCacheEntry // tenantID -> entry
}

// NewDispatcher builds a Dispatcher with sane defaults.
func NewDispatcher(store *Store, bus *events.Bus, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{
		Store:  store,
		Bus:    bus,
		Log:    logger,
		Topics: append([]string(nil), AllowedEvents...),
		cache:  make(map[string]*tenantCacheEntry),
	}
}

// Run registers the dispatcher as a synchronous publish hook and blocks until
// shutdown. Registering here keeps worker lifecycle ownership in one place.
func (d *Dispatcher) Run(ctx context.Context) error {
	if d == nil || d.Bus == nil || d.Store == nil {
		return nil
	}
	logger := d.Log
	if logger == nil {
		logger = slog.Default()
	}
	d.Log = logger
	d.Bus.AddPublishHook(d)
	<-ctx.Done()
	return ctx.Err()
}

// OnPublish implements events.PublishHook for compatibility only.
// Transactionally owned topics are deliberately ignored: their canonical
// delivery rows already commit with the mutation, and sending the
// presentation-only bus echo through this hook would create a second customer
// delivery with a different bus event ID.
func (d *Dispatcher) OnPublish(ctx context.Context, evt events.Event) {
	if d == nil || !IsAllowedEvent(evt.Topic) || isTransactionallyOwnedEvent(evt.Topic) {
		return
	}
	dispatchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := d.Dispatch(dispatchCtx, evt); err != nil {
		logger := d.Log
		if logger == nil {
			logger = slog.Default()
		}
		logger.Error("outbound_webhooks: publish fanout failed",
			"event_id", evt.ID, "tenant", evt.TenantID, "topic", evt.Topic, "err", err.Error())
	}
}

// isTransactionallyOwnedEvent reports whether a topic's fanout commits with the
// producer's transaction rather than through the bus.
//
// DERIVED from AllowedEvents rather than listed again. It was a second literal
// copy of the same ten topics, which meant adding an event required editing two
// places and forgetting the second produced a topic tenants could subscribe to
// and would never receive — a silent, per-event failure with no error anywhere.
//
// The two concepts are not the same idea, they merely coincide: every topic we
// have chosen to publish is one whose producer holds a transaction. If a future
// topic is genuinely bus-only (a periodic aggregate, say, with no originating
// mutation), this becomes a real predicate again — and the honest way to write
// it then is an explicit exception list here, so the divergence is named rather
// than reintroduced as a silent second copy.
func isTransactionallyOwnedEvent(topic string) bool {
	return IsAllowedEvent(topic)
}

// Dispatch enqueues one delivery row per matching webhook for evt.
// Public so call sites that bypass the bus (e.g. inline test
// triggers) can fan out without going through the bus first.
//
// list.subscriber.* events additionally honor each webhook's list_id
// scope: a webhook with list_id="X" only fires when the event payload
// carries data.list_id == "X". Tenant-wide webhooks (list_id="") see
// every list.subscriber.* event for the tenant.
func (d *Dispatcher) Dispatch(ctx context.Context, evt events.Event) error {
	if d == nil || d.Store == nil {
		return nil
	}
	if evt.TenantID == "" || evt.Topic == "" {
		return nil
	}
	if !IsAllowedEvent(evt.Topic) {
		return nil
	}
	if evt.At.IsZero() {
		evt.At = time.Now().UTC()
	}
	sourceEventID := canonicalSourceEventID(evt)
	hooks, err := d.matchingWebhooks(ctx, evt.TenantID, evt.Topic)
	if err != nil {
		return err
	}
	if len(hooks) == 0 {
		return nil
	}
	envelope := buildEnvelope(evt, sourceEventID)
	body, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	payloadListID := extractListID(evt)
	for _, h := range hooks {
		if h.ListID != "" && h.ListID != payloadListID {
			continue
		}
		if _, err := d.Store.EnqueueDelivery(ctx, evt.TenantID, h.ID, evt.Topic, sourceEventID, body); err != nil {
			return err
		}
	}
	return nil
}

func canonicalSourceEventID(evt events.Event) string {
	if evt.ID != "" {
		if parsed, err := uuid.Parse(evt.ID); err == nil {
			return parsed.String()
		}
	}
	payload, _ := json.Marshal(evt.Payload)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s",
		evt.TenantID, evt.Topic, evt.ID, evt.At.UTC().Format(time.RFC3339Nano), payload)))
	// UUID-shaped deterministic fallback keeps the storage contract strict for
	// legacy direct Dispatch callers that did not provide an event id.
	raw := sum[:16]
	raw[6] = (raw[6] & 0x0f) | 0x50
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// matchingWebhooks returns the (cached) set of webhooks subscribed to
// eventType for tenantID. Cache TTL is tenantCacheTTL.
func (d *Dispatcher) matchingWebhooks(ctx context.Context, tenantID, eventType string) ([]scopedWebhook, error) {
	now := time.Now()
	d.cacheMu.RLock()
	entry, ok := d.cache[tenantID]
	d.cacheMu.RUnlock()
	if ok && now.Sub(entry.at) < tenantCacheTTL {
		return entry.byEvt[eventType], nil
	}
	// Refresh: load every active webhook for the tenant in one query
	// and bucket by event type. Keeps the per-event hot path to a
	// single map lookup.
	rows, err := d.Store.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	byEvt := make(map[string][]scopedWebhook)
	for _, w := range rows {
		if !w.Active {
			continue
		}
		for _, e := range w.Events {
			byEvt[e] = append(byEvt[e], scopedWebhook{ID: w.ID, ListID: w.ListID})
		}
	}
	d.cacheMu.Lock()
	d.cache[tenantID] = &tenantCacheEntry{at: now, byEvt: byEvt}
	d.cacheMu.Unlock()
	return byEvt[eventType], nil
}

// extractListID pulls data.list_id out of an event payload, if present.
// list.subscriber.* events publish their list scope under that key so
// the dispatcher can scope deliveries without re-decoding the
// outbound envelope.
func extractListID(evt events.Event) string {
	if evt.Payload == nil {
		return ""
	}
	if v, ok := evt.Payload["list_id"]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// InvalidateTenant nukes the cache for tenantID so the next Dispatch
// re-reads the DB. Called from Create/Update/Delete handlers when we
// know a webhook just changed.
func (d *Dispatcher) InvalidateTenant(tenantID string) {
	if d == nil {
		return
	}
	d.cacheMu.Lock()
	delete(d.cache, tenantID)
	d.cacheMu.Unlock()
}

// buildEnvelope translates a bus event into the outbound JSON shape
// customers see on the wire. Webhook + delivery ids are filled by the
// worker right before signing (the dispatcher only knows the event).
func buildEnvelope(evt events.Event, sourceEventID string) map[string]any {
	at := evt.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	data := evt.Payload
	if data == nil {
		data = map[string]any{}
	}
	return map[string]any{
		"event": map[string]any{
			"id":          sourceEventID,
			"type":        evt.Topic,
			"occurred_at": at.UTC().Format(time.RFC3339),
			"data":        data,
		},
	}
}
