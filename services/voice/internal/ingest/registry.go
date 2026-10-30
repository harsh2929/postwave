package ingest

import (
	"fmt"
	"sync"
)

// Registry maps SourceType → Source implementation.
//
// A single process-wide Registry is convenient but each test can also
// instantiate its own to avoid global state.
type Registry struct {
	mu      sync.RWMutex
	sources map[SourceType]Source
}

// NewRegistry constructs an empty registry.
func NewRegistry() *Registry {
	return &Registry{sources: map[SourceType]Source{}}
}

// Register attaches a Source to its declared Type().
func (r *Registry) Register(s Source) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sources[s.Type()] = s
}

// Get returns a registered Source by type, or an error.
func (r *Registry) Get(t SourceType) (Source, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sources[t]
	if !ok {
		return nil, fmt.Errorf("ingest: no source registered for %q", t)
	}
	return s, nil
}

// Types returns the registered source types in stable but unspecified order.
func (r *Registry) Types() []SourceType {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]SourceType, 0, len(r.sources))
	for t := range r.sources {
		out = append(out, t)
	}
	return out
}
