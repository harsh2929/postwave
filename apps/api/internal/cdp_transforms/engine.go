// SPDX-License-Identifier: AGPL-3.0-only
//
// engine.go — the transform engine. A transform is a sequence of
// Ops applied left-to-right against a property map. Each Op
// resolves to a handler via the package-level registry.

package cdp_transforms

import (
	"errors"
	"fmt"
	"strings"
)

// Op is one step in a transform. Field uses dotted-path notation for
// nested access ("address.country"). Args is op-specific; see each
// handler in handlers.go for the shape it expects.
type Op struct {
	Type  string         `json:"type"`
	Field string         `json:"field"`
	Args  map[string]any `json:"args,omitempty"`
}

// Result captures a single Op's outcome on a record.
type Result struct {
	Op       Op     `json:"op"`
	Changed  bool   `json:"changed"`
	OldValue any    `json:"old_value,omitempty"`
	NewValue any    `json:"new_value,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Outcome bundles per-record results. Success counts ops where the
// handler returned without error (whether or not the value changed).
type Outcome struct {
	Properties map[string]any `json:"properties"`
	Results    []Result       `json:"results"`
	Success    int            `json:"success"`
	Failed     int            `json:"failed"`
}

// Handler is the op-implementation signature. It returns the new
// value for Op.Field and a bool indicating whether the value
// actually changed. Returning (nil, false, nil) without an error
// means "no-op". The current value of Op.Field is passed as `cur`
// so handlers don't need to re-walk the map.
type Handler func(cur any, op Op) (newVal any, changed bool, err error)

var registry = map[string]Handler{}

// Register exposes a handler under name. Calling Register twice with
// the same name panics so duplicate definitions surface at boot.
func Register(name string, h Handler) {
	if _, exists := registry[name]; exists {
		panic(fmt.Sprintf("cdp_transforms: handler %q already registered", name))
	}
	registry[name] = h
}

// Registered returns the names of every registered handler. Useful
// for /transforms/ops discovery endpoints.
func Registered() []string {
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	return out
}

// Apply runs ops against properties in order and returns the new
// map + per-op trace. The input map is never mutated; we deep-clone
// before mutating so callers can compare before/after if they want.
func Apply(properties map[string]any, ops []Op) Outcome {
	if properties == nil {
		properties = map[string]any{}
	}
	out := deepClone(properties)
	res := make([]Result, 0, len(ops))
	var ok, fail int
	for _, op := range ops {
		r, applied := applyOne(out, op)
		res = append(res, r)
		if r.Error != "" {
			fail++
			continue
		}
		ok++
		if !applied {
			continue
		}
		if _, isTombstone := r.NewValue.(tombstone); isTombstone {
			deleteField(out, op.Field)
			// Hide the tombstone from callers reading the trace.
			r.NewValue = nil
			res[len(res)-1] = r
			continue
		}
		setField(out, op.Field, r.NewValue)
	}
	return Outcome{Properties: out, Results: res, Success: ok, Failed: fail}
}

func applyOne(properties map[string]any, op Op) (Result, bool) {
	if op.Type == "" {
		return Result{Op: op, Error: "type required"}, false
	}
	h, ok := registry[op.Type]
	if !ok {
		return Result{Op: op, Error: fmt.Sprintf("unknown op %q", op.Type)}, false
	}
	cur := getField(properties, op.Field)
	newVal, changed, err := h(cur, op)
	if err != nil {
		return Result{Op: op, Error: err.Error(), OldValue: cur}, false
	}
	return Result{Op: op, Changed: changed, OldValue: cur, NewValue: newVal}, changed
}

// --- dotted-path field access ---

func splitPath(path string) []string {
	if path == "" {
		return nil
	}
	return strings.Split(path, ".")
}

func getField(properties map[string]any, path string) any {
	parts := splitPath(path)
	var cur any = properties
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

// setField writes value at path, creating intermediate maps where
// needed. If a segment exists but isn't a map, it overwrites it.
func setField(properties map[string]any, path string, value any) {
	parts := splitPath(path)
	if len(parts) == 0 {
		return
	}
	cur := properties
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[parts[i]] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = value
}

// deleteField removes a path and trims empty intermediate maps.
func deleteField(properties map[string]any, path string) {
	parts := splitPath(path)
	if len(parts) == 0 {
		return
	}
	cur := properties
	stack := []map[string]any{cur}
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]any)
		if !ok {
			return
		}
		stack = append(stack, next)
		cur = next
	}
	delete(cur, parts[len(parts)-1])
	for i := len(stack) - 1; i > 0; i-- {
		if len(stack[i]) == 0 {
			delete(stack[i-1], parts[i-1])
			continue
		}
		break
	}
}

func deepClone(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = cloneValue(v)
	}
	return out
}

func cloneValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return deepClone(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = cloneValue(e)
		}
		return out
	default:
		return v
	}
}

// --- arg helpers used by handlers ---

func argString(args map[string]any, name string) (string, bool) {
	if args == nil {
		return "", false
	}
	v, ok := args[name]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func argInt(args map[string]any, name string) (int, bool) {
	if args == nil {
		return 0, false
	}
	v, ok := args[name]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case int:
		return x, true
	case float64:
		return int(x), true
	}
	return 0, false
}

// ErrInvalidArgs is the canonical "args are wrong" error. Handlers
// wrap with fmt.Errorf to add context.
var ErrInvalidArgs = errors.New("invalid args")
