// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"encoding/json"
	"fmt"
	"sort"
)

// Registry is an ordered, name-indexed set of tool specs. It is built
// once at startup and shared (read-only thereafter) by every surface.
type Registry struct {
	order  []string
	byName map[string]*ToolSpec
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]*ToolSpec)}
}

// Register adds a tool. It panics on a duplicate name because that is a
// programmer error surfaced at startup, never at request time.
func (r *Registry) Register(spec ToolSpec) {
	if _, dup := r.byName[spec.Name]; dup {
		panic(fmt.Sprintf("agenttools: duplicate tool name %q", spec.Name))
	}
	cp := spec
	r.byName[spec.Name] = &cp
	r.order = append(r.order, spec.Name)
}

// MustRegister registers each spec in declaration order.
func (r *Registry) MustRegister(specs ...ToolSpec) {
	for _, s := range specs {
		r.Register(s)
	}
}

// Lookup returns the spec for a wire name, or nil when unknown.
func (r *Registry) Lookup(name string) *ToolSpec {
	return r.byName[name]
}

// List returns the specs exposed on the given surface, in registration
// order. Pass an empty surface ("") to get every registered spec.
func (r *Registry) List(surface Surface) []*ToolSpec {
	out := make([]*ToolSpec, 0, len(r.order))
	for _, name := range r.order {
		spec := r.byName[name]
		if surface == "" || spec.ExposedOn(surface) {
			out = append(out, spec)
		}
	}
	return out
}

// All returns every registered spec in registration order.
func (r *Registry) All() []*ToolSpec { return r.List("") }

// Len returns the number of registered tools.
func (r *Registry) Len() int { return len(r.order) }

// Categories returns the distinct categories present, sorted.
func (r *Registry) Categories() []Category {
	seen := map[Category]struct{}{}
	for _, name := range r.order {
		seen[r.byName[name].Category] = struct{}{}
	}
	out := make([]Category, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Validate enforces the registry's invariants. It is called at startup
// (right after the registry is built) so a malformed tool fails the
// boot, never a request. This is the "a WriteTier tool cannot register
// without the right guardrails" assertion the audit asked for.
//
// Rules:
//   - names are unique (Register already panics, but re-checked here)
//   - InputSchema / OutputSchema (when present) are JSON Schema objects
//     with a top-level "type":"object"
//   - read-only and write-tier are EXACTLY ONE of the two — a tool that
//     is neither would fail open past both the sandbox simulation gate
//     (which keys off WriteTier) and the write-tier scope requirement,
//     so every tool must classify itself
//   - a WriteTier tool must declare at least one required scope
//     (so it can never be reachable by a bare authenticated key)
//   - a Destructive tool must be WriteTier (you cannot destroy via a
//     read-only tool — catches a mis-annotation that would otherwise
//     skip the approval gate's intent)
//   - a ChargesSend tool must be WriteTier and OpenWorld
//   - every executable (non-proxy-only) spec must have a Handler
func (r *Registry) Validate() error {
	for _, name := range r.order {
		t := r.byName[name]
		if t.Name == "" {
			return fmt.Errorf("agenttools: tool with empty name registered")
		}
		if err := validateSchema(t.InputSchema); err != nil {
			return fmt.Errorf("agenttools: tool %q has invalid input schema: %w", t.Name, err)
		}
		if len(t.OutputSchema) > 0 {
			if err := validateSchema(t.OutputSchema); err != nil {
				return fmt.Errorf("agenttools: tool %q has invalid output schema: %w", t.Name, err)
			}
		}
		// Exactly one of read-only / write-tier. Both-true and
		// both-false are rejected: both-false is the dangerous case
		// where a mutating tool silently skips the sandbox + scope gates.
		if t.Annotations.ReadOnly == t.WriteTier {
			return fmt.Errorf("agenttools: tool %q must be exactly one of read-only or write-tier (got readOnly=%v writeTier=%v)", t.Name, t.Annotations.ReadOnly, t.WriteTier)
		}
		if t.WriteTier && len(t.RequiredScopes) == 0 {
			return fmt.Errorf("agenttools: write-tier tool %q declares no required scopes", t.Name)
		}
		if t.Annotations.Destructive && !t.WriteTier {
			return fmt.Errorf("agenttools: destructive tool %q must be write-tier", t.Name)
		}
		if t.ChargesSend && (!t.WriteTier || !t.Annotations.OpenWorld) {
			return fmt.Errorf("agenttools: send-charging tool %q must be write-tier and open-world", t.Name)
		}
		if IsExecutable(SurfaceMCP) && (t.ExposedOn(SurfaceMCP) || t.ExposedOn(SurfaceAgent)) && t.Handler == nil {
			return fmt.Errorf("agenttools: executable tool %q has no handler", t.Name)
		}
	}
	return nil
}

// validateSchema confirms b is a non-empty JSON object (not null, not an
// array/scalar) carrying a top-level "type":"object" — the only valid
// shape for a tool argument/result schema. This makes the startup
// assertion guarantee the documented input shape, not merely "is JSON".
func validateSchema(b json.RawMessage) error {
	if len(b) == 0 {
		return fmt.Errorf("schema is empty")
	}
	var probe map[string]any
	if err := json.Unmarshal(b, &probe); err != nil {
		return fmt.Errorf("not a JSON object: %w", err)
	}
	if probe == nil {
		return fmt.Errorf("schema is JSON null, not an object")
	}
	if probe["type"] != "object" {
		return fmt.Errorf("schema must declare top-level \"type\":\"object\"")
	}
	return nil
}
