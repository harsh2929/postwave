// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"strings"
	"sync"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Presence tracks the live SSE connection count per tenant and emits
// `presence.update` events on every change. The desktop shell renders
// a small avatar stack from this so collaborators see one another.
//
// Implementation notes:
//   - The tracker hooks into Bus.Subscribe / Bus.Unsubscribe via the
//     SubscriberHook interface — no polling.
//   - Counts are conservative: we count *connections*, not distinct
//     users (one human with the desktop + mobile open is "2"). When the
//     SSE handler calls SubscribeAs (today's path) we get the real
//     user_id + user_label off the Subscriber and surface those in the
//     presence payload; when it doesn't we fall back to a stable
//     "user-N" placeholder so the wire format stays valid.
//   - Wire format: each presence.update event carries BOTH the legacy
//     `users: ["label", ...]` field (back-compat for clients still on
//     the bare-string shape) AND the new `users_v2: [{id, label}, ...]`
//     field with structured identity. New clients should prefer
//     users_v2; old clients keep working until they're updated.
//   - The presence event itself is published on the same Bus so any
//     subscriber listening to "presence.*" picks it up. The handler
//     filters by tenant_id like every other domain event.
type Presence struct {
	bus *Bus

	mu       sync.Mutex
	counts   map[string]int                       // tenant_id -> open connection count
	bySubID  map[uint64]presenceMember            // subscriber id -> member (so Unsubscribe knows)
	byTenant map[string]map[uint64]presenceMember // tenant_id -> {subID -> member}
	// byEntity tracks who is viewing a specific record (SHELL-036), keyed by
	// entityKey(tenant, entityRef). A connection appears here only when it
	// subscribed with a non-empty EntityRef (a detail page), in addition to
	// its normal tenant-global membership above.
	byEntity map[string]map[uint64]presenceMember
	// subEntity remembers each subscriber's entity key so Unsubscribe can drop
	// the exact entry (the Subscriber pointer is the same, but keeping the key
	// avoids re-deriving it).
	subEntity map[uint64]string
}

// presenceMember is the per-connection identity we surface in events.
// Stored keyed by subscriber id so Unsubscribe can drop the exact entry
// (rather than the older "trim the last label" approximation).
type presenceMember struct {
	ID    string // user id, or "" when no auth context
	Label string // user email/display, or placeholder
}

// PresenceUser is the structured identity emitted in presence.update
// events under `users_v2`. Pointers are not used — empty fields are
// sent as empty strings so clients can render a placeholder.
type PresenceUser struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// NewPresence wires a Presence tracker into bus. Returns the tracker so
// callers can read SubscriberCount directly when needed (tests).
func NewPresence(bus *Bus) *Presence {
	p := &Presence{
		bus:       bus,
		counts:    make(map[string]int),
		bySubID:   make(map[uint64]presenceMember),
		byTenant:  make(map[string]map[uint64]presenceMember),
		byEntity:  make(map[string]map[uint64]presenceMember),
		subEntity: make(map[uint64]string),
	}
	bus.AddHook(p)
	return p
}

// entityKey namespaces an entity ref by tenant so two tenants viewing the same
// opaque id never collide.
func entityKey(tenantID, entityRef string) string {
	return tenantID + "\x00" + entityRef
}

// PresenceEntityTopic is the topic entity-scoped presence.update events are
// published on. Clients viewing a record subscribe to it and filter payloads
// to their own entity_ref.
const PresenceEntityTopic = "presence.entity"

// OnSubscribe is invoked by Bus when a new connection registers. We
// bump the tenant counter, attach the user identity (or a placeholder),
// and publish a presence.update event so other clients on the same tenant
// re-render.
func (p *Presence) OnSubscribe(s *Subscriber) {
	if s == nil || s.TenantID == "" {
		return
	}
	label := s.UserLabel
	if label == "" {
		// Stable per-connection placeholder; only used when the SSE
		// handler couldn't resolve a user (e.g. dev-mode bypass paths).
		label = placeholderLabel(s.ID)
	}
	member := presenceMember{ID: s.UserID, Label: label}
	p.mu.Lock()
	p.counts[s.TenantID]++
	p.bySubID[s.ID] = member
	tenantMap, ok := p.byTenant[s.TenantID]
	if !ok {
		tenantMap = make(map[uint64]presenceMember)
		p.byTenant[s.TenantID] = tenantMap
	}
	tenantMap[s.ID] = member
	count := p.counts[s.TenantID]
	users, usersV2 := p.snapshotLocked(s.TenantID)

	// Per-entity membership (SHELL-036): only for connections scoped to a
	// record. Captured under the same lock so the entity snapshot is consistent.
	var (
		entityRef     string
		entityUsers   []string
		entityUsersV2 []PresenceUser
		entityCount   int
		hasEntity     bool
	)
	if s.EntityRef != "" {
		key := entityKey(s.TenantID, s.EntityRef)
		entityMap, ok := p.byEntity[key]
		if !ok {
			entityMap = make(map[uint64]presenceMember)
			p.byEntity[key] = entityMap
		}
		entityMap[s.ID] = member
		p.subEntity[s.ID] = key
		entityRef = s.EntityRef
		entityUsers, entityUsersV2 = membersToSlices(entityMap)
		entityCount = len(entityMap)
		hasEntity = true
	}
	p.mu.Unlock()

	p.publish(s.TenantID, count, users, usersV2)
	if hasEntity {
		p.publishEntity(s.TenantID, entityRef, entityCount, entityUsers, entityUsersV2)
	}
}

// OnUnsubscribe is invoked by Bus when a connection drops. Decrement,
// remove the per-subscriber identity entry, publish.
func (p *Presence) OnUnsubscribe(s *Subscriber) {
	if s == nil {
		return
	}
	p.mu.Lock()
	member, ok := p.bySubID[s.ID]
	if !ok {
		p.mu.Unlock()
		return
	}
	_ = member
	delete(p.bySubID, s.ID)
	tenantID := s.TenantID
	if tenantMap, ok := p.byTenant[tenantID]; ok {
		delete(tenantMap, s.ID)
		if len(tenantMap) == 0 {
			delete(p.byTenant, tenantID)
		}
	}
	p.counts[tenantID]--
	if p.counts[tenantID] <= 0 {
		delete(p.counts, tenantID)
	}
	count := p.counts[tenantID]
	users, usersV2 := p.snapshotLocked(tenantID)

	// Drop per-entity membership (SHELL-036) if this connection had one.
	var (
		entityRef     string
		entityUsers   []string
		entityUsersV2 []PresenceUser
		entityCount   int
		hasEntity     bool
	)
	if key, ok := p.subEntity[s.ID]; ok {
		delete(p.subEntity, s.ID)
		if entityMap, ok := p.byEntity[key]; ok {
			delete(entityMap, s.ID)
			entityUsers, entityUsersV2 = membersToSlices(entityMap)
			entityCount = len(entityMap)
			if entityCount == 0 {
				delete(p.byEntity, key)
			}
		}
		// Recover the ref from the key (tenant\x00ref).
		if i := strings.IndexByte(key, '\x00'); i >= 0 {
			entityRef = key[i+1:]
		}
		hasEntity = true
	}
	p.mu.Unlock()

	p.publish(tenantID, count, users, usersV2)
	if hasEntity {
		p.publishEntity(tenantID, entityRef, entityCount, entityUsers, entityUsersV2)
	}
}

// snapshotLocked returns the legacy []string and the new []PresenceUser
// forms of the tenant's current member list. The caller must hold p.mu.
// Two separate slices keeps the wire JSON unambiguous: a v1 client only
// sees `users: ["alice@x"]`, a v2 client reads `users_v2: [{id,label}]`.
func (p *Presence) snapshotLocked(tenantID string) ([]string, []PresenceUser) {
	return membersToSlices(p.byTenant[tenantID])
}

// membersToSlices renders a member map into the legacy []string labels + the
// structured []PresenceUser. Shared by the tenant-global and per-entity paths.
func membersToSlices(members map[uint64]presenceMember) ([]string, []PresenceUser) {
	out1 := make([]string, 0, len(members))
	out2 := make([]PresenceUser, 0, len(members))
	for _, m := range members {
		out1 = append(out1, m.Label)
		out2 = append(out2, PresenceUser{ID: m.ID, Label: m.Label})
	}
	return out1, out2
}

// Count returns the live connection count for a tenant. Helper for
// tests + future debug endpoints.
func (p *Presence) Count(tenantID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[tenantID]
}

func (p *Presence) publish(tenantID string, count int, users []string, usersV2 []PresenceUser) {
	if p.bus == nil {
		return
	}
	p.bus.Publish(Event{
		Topic:    "presence.update",
		TenantID: tenantID,
		Payload: map[string]any{
			"count":    count,
			"users":    users,   // legacy: []string of labels
			"users_v2": usersV2, // new: [{id, label}]
		},
	})
}

// publishEntity emits an entity-scoped presence.update on PresenceEntityTopic
// (SHELL-036). The payload carries entity_ref so a client can filter to the
// record it is viewing; the bus already scopes delivery to the tenant.
func (p *Presence) publishEntity(tenantID, entityRef string, count int, users []string, usersV2 []PresenceUser) {
	if p.bus == nil || entityRef == "" {
		return
	}
	p.bus.Publish(Event{
		Topic:    PresenceEntityTopic,
		TenantID: tenantID,
		Payload: map[string]any{
			"entity_ref": entityRef,
			"count":      count,
			"users":      users,
			"users_v2":   usersV2,
		},
	})
}

// presenceDisplayLabel converts an authenticated user into the label we
// expose to OTHER sessions in the same tenant (presence avatar stack,
// cursor overlay). middleware.User has no display-name field today, so
// the best human-readable, privacy-safe form is the email local-part:
// "alice@example.com" → "alice". The full address is deliberately never
// emitted — presence payloads fan out to every connected session of the
// tenant and must not become an email-harvesting surface.
func presenceDisplayLabel(u *middleware.User) string {
	if u == nil {
		return ""
	}
	email := strings.TrimSpace(u.Email)
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return email
}

func placeholderLabel(id uint64) string {
	// "user-1234" — opaque + small. Used only when no auth context is
	// attached; the SSE handler now plumbs middleware.UserFromContext
	// through SubscribeAs so the common path uses real labels.
	return "user-" + formatUint(id)
}

func formatUint(id uint64) string {
	if id == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for id > 0 {
		i--
		buf[i] = byte('0' + id%10)
		id /= 10
	}
	return string(buf[i:])
}
