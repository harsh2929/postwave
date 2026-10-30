// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

func okSchema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }

func noopHandler(context.Context, json.RawMessage) (any, error) { return nil, nil }

func readSpec(name string) ToolSpec {
	return ToolSpec{Name: name, Category: CategoryAnalytics, Description: "d",
		InputSchema: okSchema(), Annotations: Annotations{ReadOnly: true},
		Handler: noopHandler}
}

func TestRegistry_validateHappy(t *testing.T) {
	r := NewRegistry()
	r.Register(readSpec("a"))
	r.Register(ToolSpec{
		Name: "b", Category: CategoryAudience, Description: "d", InputSchema: okSchema(),
		WriteTier: true, RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
		Handler: noopHandler,
	})
	if err := r.Validate(); err != nil {
		t.Fatalf("valid registry rejected: %v", err)
	}
	if r.Len() != 2 {
		t.Fatalf("want 2 tools, got %d", r.Len())
	}
}

func TestRegistry_duplicatePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("duplicate registration should panic")
		}
	}()
	r := NewRegistry()
	r.Register(readSpec("dup"))
	r.Register(readSpec("dup"))
}

func TestRegistry_validateRules(t *testing.T) {
	cases := []struct {
		name string
		spec ToolSpec
	}{
		{"readonly+writetier (both true)", ToolSpec{Name: "x", InputSchema: okSchema(), WriteTier: true,
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			Annotations:    Annotations{ReadOnly: true}, Handler: noopHandler}},
		{"neither readonly nor writetier (both false — the fail-open case)", ToolSpec{Name: "x",
			InputSchema: okSchema(), Handler: noopHandler}},
		{"writetier no scopes", ToolSpec{Name: "x", InputSchema: okSchema(), WriteTier: true,
			Handler: noopHandler}},
		{"destructive not writetier", ToolSpec{Name: "x", InputSchema: okSchema(),
			Annotations: Annotations{ReadOnly: true, Destructive: true}, Handler: noopHandler}},
		{"chargessend not openworld", ToolSpec{Name: "x", InputSchema: okSchema(), WriteTier: true,
			ChargesSend: true, RequiredScopes: []apikeys.Scope{apikeys.ScopeSendTransactional},
			Handler: noopHandler}},
		{"bad schema", ToolSpec{Name: "x", InputSchema: json.RawMessage(`not json`),
			Annotations: Annotations{ReadOnly: true}, Handler: noopHandler}},
		{"null schema", ToolSpec{Name: "x", InputSchema: json.RawMessage(`null`),
			Annotations: Annotations{ReadOnly: true}, Handler: noopHandler}},
		{"schema not type object", ToolSpec{Name: "x", InputSchema: json.RawMessage(`{"type":"string"}`),
			Annotations: Annotations{ReadOnly: true}, Handler: noopHandler}},
		{"executable no handler", ToolSpec{Name: "x", InputSchema: okSchema(),
			Annotations: Annotations{ReadOnly: true}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := NewRegistry()
			r.Register(c.spec)
			if err := r.Validate(); err == nil {
				t.Fatalf("expected validation error for %q", c.name)
			}
		})
	}
}

func TestRegistry_proxyOnlyNeedsNoHandler(t *testing.T) {
	r := NewRegistry()
	r.Register(ToolSpec{Name: "legacy", Category: CategoryIntegrations, Description: "d",
		InputSchema: okSchema(), Annotations: Annotations{ReadOnly: true},
		Surfaces: []Surface{SurfaceProxy}}) // proxy-only, no handler
	if err := r.Validate(); err != nil {
		t.Fatalf("proxy-only spec without a handler should validate: %v", err)
	}
}

func TestRegistry_listBySurface(t *testing.T) {
	r := NewRegistry()
	r.Register(readSpec("everywhere")) // mcp+agent
	r.Register(ToolSpec{Name: "proxyonly", InputSchema: okSchema(), Description: "d",
		Annotations: Annotations{ReadOnly: true}, Surfaces: []Surface{SurfaceProxy}})

	if got := len(r.List(SurfaceMCP)); got != 1 {
		t.Fatalf("MCP surface should list 1 tool, got %d", got)
	}
	if got := len(r.List(SurfaceProxy)); got != 1 {
		t.Fatalf("proxy surface should list 1 tool, got %d", got)
	}
	if got := len(r.All()); got != 2 {
		t.Fatalf("All should return 2 tools, got %d", got)
	}
}
