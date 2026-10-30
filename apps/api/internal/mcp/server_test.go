// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Test the static tool registry shape — every tool ships a non-empty
// name, description, and a JSON-Schema input object. These would
// otherwise surface as silent failures at runtime when an LLM probes
// tools/list.
func TestAllToolsHaveSchema(t *testing.T) {
	t.Parallel()
	d := &Deps{}
	tools := d.allTools()
	if len(tools) == 0 {
		t.Fatal("expected at least one tool")
	}
	seen := map[string]bool{}
	for _, tl := range tools {
		if tl.Name == "" {
			t.Errorf("tool with empty name: %+v", tl)
		}
		if seen[tl.Name] {
			t.Errorf("duplicate tool name: %s", tl.Name)
		}
		seen[tl.Name] = true
		if tl.Description == "" {
			t.Errorf("tool %q has empty description", tl.Name)
		}
		if len(tl.InputSchema) == 0 {
			t.Errorf("tool %q has empty inputSchema", tl.Name)
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal(tl.InputSchema, &parsed); err != nil {
			t.Errorf("tool %q has invalid JSON in inputSchema: %v", tl.Name, err)
		}
		if parsed["type"] != "object" {
			t.Errorf("tool %q schema root must be type=object", tl.Name)
		}
	}
}

// Test that the shared registry builds, passes its startup validation
// (this is the CI-time assertion that no tool is mis-declared), resolves
// known tools, rejects unknown ones, and carries the right annotations.
func TestRegistryLookupAndValidate(t *testing.T) {
	t.Parallel()
	d := &Deps{} // nil Pool is fine: Registry() never invokes handlers
	reg := d.Registry()
	if reg.Lookup("getStats") == nil {
		t.Fatal("registry should resolve getStats")
	}
	if reg.Lookup("definitelyNotARealTool") != nil {
		t.Fatal("registry must not resolve an unknown tool")
	}
	if s := reg.Lookup("getStats"); s == nil || !s.Annotations.ReadOnly || s.WriteTier || !s.LLMOutputSafe {
		t.Fatalf("getStats should be read-only with a reviewed model-output projection: %+v", s)
	}
	if s := reg.Lookup("getSubscriberProfile"); s == nil || s.LLMOutputSafe {
		t.Fatalf("subscriber profile must remain held from model context: %+v", s)
	}
	if s := reg.Lookup("upsertSubscriberAlias"); s == nil || !s.WriteTier || s.Annotations.ReadOnly {
		t.Fatalf("upsertSubscriberAlias should be write-tier: %+v", s)
	}
}

// Test the containsString helper used for the allowlist intersection.
func TestContainsString(t *testing.T) {
	t.Parallel()
	cases := []struct {
		hay    []string
		needle string
		want   bool
	}{
		{nil, "x", false},
		{[]string{}, "x", false},
		{[]string{"a", "b"}, "a", true},
		{[]string{"a", "b"}, "c", false},
		{[]string{"only"}, "only", true},
	}
	for _, c := range cases {
		if got := containsString(c.hay, c.needle); got != c.want {
			t.Errorf("containsString(%v,%q) = %v, want %v", c.hay, c.needle, got, c.want)
		}
	}
}

// Test the JSON-RPC error envelope shape. The transport returns HTTP
// 200 with the error inside the JSON body — this is JSON-RPC 2.0
// canonical behaviour, distinct from REST.
func TestRPCResponseShape(t *testing.T) {
	t.Parallel()
	resp := rpcResponse{
		JSONRPC: "2.0",
		Result:  map[string]string{"x": "y"},
	}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["jsonrpc"] != "2.0" {
		t.Errorf("missing jsonrpc=2.0 envelope: %s", string(b))
	}
	if _, hasErr := m["error"]; hasErr {
		t.Errorf("success response must not carry error field: %s", string(b))
	}
}

func TestWriteToolCallResultSanitizesUnclassifiedErrors(t *testing.T) {
	t.Parallel()
	d := &Deps{}
	w := httptest.NewRecorder()
	d.writeToolCallResult(w, &rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1")},
		&agenttools.Result{Outcome: agenttools.OutcomeError},
		errors.New("pq: private_schema.secret_table password=hidden"))

	var envelope rpcResponse
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Error == nil || envelope.Error.Code != errInternalError {
		t.Fatalf("response=%s want internal JSON-RPC error", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private_schema") || strings.Contains(w.Body.String(), "password") {
		t.Fatalf("private handler detail reached MCP response: %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	d.writeToolCallResult(w, &rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("2")},
		&agenttools.Result{Outcome: agenttools.OutcomeDenied}, agenttools.ErrQuotaExceeded)
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode quota response: %v", err)
	}
	if envelope.Error == nil || envelope.Error.Code != errQuotaExceeded {
		t.Fatalf("known sentinel mapping drifted: %s", w.Body.String())
	}
}

func TestWriteTierReleaseHoldHidesWritesEvenForStaleEnabledSetting(t *testing.T) {
	d := &Deps{}
	ctx := apikeys.WithScopes(context.Background(), []apikeys.Scope{apikeys.ScopeAdmin})
	w := httptest.NewRecorder()
	d.handleToolsList(ctx, w, &rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1")}, &Settings{WriteEnabled: true})

	var envelope struct {
		Result toolsListResult `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Result.Tools) == 0 {
		t.Fatal("release hold should preserve scoped read-only tools")
	}
	for _, descriptor := range envelope.Result.Tools {
		spec := d.Registry().Lookup(descriptor.Name)
		if spec == nil {
			t.Fatalf("listed unknown tool %q", descriptor.Name)
		}
		if spec.WriteTier {
			t.Fatalf("write-tier tool %q escaped structural release hold", descriptor.Name)
		}
		if !spec.LLMOutputSafe {
			t.Fatalf("unreviewed model-output tool %q escaped structural release hold", descriptor.Name)
		}
	}
}

func TestLLMDataEgressHoldHidesAndDeniesSubscriberProfile(t *testing.T) {
	d := &Deps{}
	ctx := apikeys.WithScopes(context.Background(), []apikeys.Scope{apikeys.ScopeReadSubscribers})
	list := httptest.NewRecorder()
	d.handleToolsList(ctx, list, &rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1")}, &Settings{})
	if strings.Contains(list.Body.String(), "getSubscriberProfile") {
		t.Fatalf("PII-rich read escaped tools/list: %s", list.Body.String())
	}

	call := httptest.NewRecorder()
	d.handleToolsCall(ctx, call, &rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage("2"),
		Params: json.RawMessage(`{"name":"getSubscriberProfile","arguments":{"id":"person@example.test"}}`),
	}, &Settings{})
	var envelope rpcResponse
	if err := json.Unmarshal(call.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error == nil || envelope.Error.Code != errScopeDenied {
		t.Fatalf("error=%+v, want stable model-output hold", envelope.Error)
	}
	data, ok := envelope.Error.Data.(map[string]any)
	if !ok || data["code"] != agenttools.LLMDataEgressReleaseHoldCode {
		t.Fatalf("error data=%#v", envelope.Error.Data)
	}
}

func TestWriteTierReleaseHoldDeniesDirectCallBeforeGovernor(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	d.handleToolsCall(context.Background(), w, &rpcRequest{
		JSONRPC: "2.0",
		ID:      json.RawMessage("1"),
		Params:  json.RawMessage(`{"name":"favoriteCampaignTemplate","arguments":{"template_id":"template-1"}}`),
	}, &Settings{WriteEnabled: true})

	var envelope rpcResponse
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error == nil || envelope.Error.Code != errWriteTierHeld {
		t.Fatalf("error=%+v, want stable write-tier hold", envelope.Error)
	}
	data, ok := envelope.Error.Data.(map[string]any)
	if !ok || data["code"] != NativeWriteTierReleaseHoldCode {
		t.Fatalf("error data=%#v, want code %q", envelope.Error.Data, NativeWriteTierReleaseHoldCode)
	}
}

func TestPatchSettingsCannotEnableWriteTierDuringReleaseHold(t *testing.T) {
	d := &Deps{}
	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/mcp/server/settings",
		strings.NewReader(`{"write_enabled":true}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"},
	))
	response := httptest.NewRecorder()
	d.PatchSettings(response, request)

	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q, want private, no-store", got)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != NativeWriteTierReleaseHoldCode {
		t.Fatalf("error code=%q", body.Error.Code)
	}
}
