package runtime

import (
	"context"
	"sync"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// SubscriberResolver looks up a Subscriber by tenant + email. Implementations
// query the read replica of the subscribers Postgres table.
type SubscriberResolver interface {
	Resolve(ctx context.Context, tenantID, email string) (canonical.Subscriber, error)
	// LookupAutomation fetches an Automation graph by id. Tenant scoping is
	// the resolver's responsibility (RLS or explicit tenant predicate).
	LookupAutomation(ctx context.Context, automationID string) (*canonical.Automation, error)
}

// BehavioralTriggerWriter appends executable trigger definitions to an
// existing automation graph. Implemented by both the in-memory local
// resolver and the Postgres resolver used in production.
type BehavioralTriggerWriter interface {
	AppendBehavioralTrigger(ctx context.Context, automationID string, trigger canonical.AutomationTrigger) (canonical.AutomationTrigger, error)
}

// MemoryResolver is the in-process resolver used by tests + the local dev
// loop (until the Postgres-backed resolver lands).
type MemoryResolver struct {
	mu          sync.RWMutex
	subs        map[string]canonical.Subscriber // key = tenantID|email
	automations map[string]*canonical.Automation
}

// NewMemoryResolver constructs an empty MemoryResolver.
func NewMemoryResolver() *MemoryResolver {
	return &MemoryResolver{
		subs:        map[string]canonical.Subscriber{},
		automations: map[string]*canonical.Automation{},
	}
}

// PutSubscriber registers a Subscriber for the given tenant.
func (r *MemoryResolver) PutSubscriber(tenantID string, sub canonical.Subscriber) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.subs[tenantID+"|"+sub.Email] = sub
}

// PutAutomation registers an Automation graph.
func (r *MemoryResolver) PutAutomation(a *canonical.Automation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.automations[a.ID] = a
}

// Resolve returns a copy of the registered Subscriber.
func (r *MemoryResolver) Resolve(ctx context.Context, tenantID, email string) (canonical.Subscriber, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s, ok := r.subs[tenantID+"|"+email]; ok {
		return s, nil
	}
	return canonical.Subscriber{}, ErrSubscriberNotFound
}

// LookupAutomation returns the registered Automation by id.
func (r *MemoryResolver) LookupAutomation(ctx context.Context, id string) (*canonical.Automation, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if a, ok := r.automations[id]; ok {
		return a, nil
	}
	return nil, ErrAutomationNotFound
}

// AppendBehavioralTrigger appends trigger to an in-memory automation graph.
func (r *MemoryResolver) AppendBehavioralTrigger(ctx context.Context, id string, trigger canonical.AutomationTrigger) (canonical.AutomationTrigger, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.automations[id]
	if !ok {
		return canonical.AutomationTrigger{}, ErrAutomationNotFound
	}
	if tenantID, ok := TenantFromContext(ctx); ok && a.TenantID != "" && tenantID != a.TenantID {
		return canonical.AutomationTrigger{}, ErrAutomationNotFound
	}
	a.Triggers = append(a.Triggers, trigger)
	return trigger, nil
}

// ListActiveByTenant returns active automations registered for a tenant.
func (r *MemoryResolver) ListActiveByTenant(ctx context.Context, tenantID string) ([]*canonical.Automation, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []*canonical.Automation{}
	for _, a := range r.automations {
		if a.TenantID == tenantID && a.Status == "active" {
			out = append(out, a)
		}
	}
	return out, nil
}
