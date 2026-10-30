// SPDX-License-Identifier: MIT

package adapter

import (
	"fmt"
	"sync"

	"github.com/postwave/migrate/canonical"
)

// Registry maps a SourcePlatform to its Adapter Constructor. Adapters
// self-register from their package init() functions so main.go just needs to
// blank-import them.
type Registry struct {
	mu    sync.RWMutex
	ctors map[canonical.SourcePlatform]Constructor
}

var defaultRegistry = &Registry{
	ctors: map[canonical.SourcePlatform]Constructor{},
}

// Register associates a Constructor with a source. Safe to call from init().
// Panics on duplicate registration (programmer error, not user-visible).
func Register(source canonical.SourcePlatform, ctor Constructor) {
	defaultRegistry.mu.Lock()
	defer defaultRegistry.mu.Unlock()
	if _, dup := defaultRegistry.ctors[source]; dup {
		panic(fmt.Sprintf("adapter: duplicate registration for %q", source))
	}
	defaultRegistry.ctors[source] = ctor
}

// Get builds a fresh Adapter for the given source. Returns ErrUnsupported when
// no adapter has registered.
func Get(source canonical.SourcePlatform) (Adapter, error) {
	defaultRegistry.mu.RLock()
	ctor, ok := defaultRegistry.ctors[source]
	defaultRegistry.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("source %q: %w", source, ErrUnsupported)
	}
	return ctor(), nil
}

// Sources returns the list of registered source platforms (stable iteration
// not guaranteed; callers sort if they need it).
func Sources() []canonical.SourcePlatform {
	defaultRegistry.mu.RLock()
	defer defaultRegistry.mu.RUnlock()
	out := make([]canonical.SourcePlatform, 0, len(defaultRegistry.ctors))
	for s := range defaultRegistry.ctors {
		out = append(out, s)
	}
	return out
}
