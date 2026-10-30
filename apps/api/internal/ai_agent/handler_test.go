// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

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

func handlerReg(t *testing.T) *agenttools.Registry {
	t.Helper()
	return regWithTools(t, agenttools.ToolSpec{
		Name: "stat_read", Category: agenttools.CategoryAnalytics, Description: "read stats",
		Annotations: agenttools.Annotations{ReadOnly: true}, RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
		Handler: func(context.Context, json.RawMessage) (any, error) { return map[string]any{"sends": 42}, nil },
	})
}

// authedRequest builds a POST with tenant + scopes on its context, as the
// auth middleware would.
func authedRequest(body string, accept string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-agent/chat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1", Slug: "acme"})
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
	return req.WithContext(ctx)
}

func TestChatHandler_jsonMode(t *testing.T) {
	llm := &scriptedLLM{responses: []*LLMResponse{
		wantTool(toolUse("t1", "stat_read", `{}`)),
		endTurn("you sent 42 emails"),
	}}
	h := &ChatHandler{Registry: handlerReg(t), Governor: protectedTestGovernor{}, LLM: llm}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authedRequest(`{"message":"how many sends?"}`, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out RunResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if out.Text != "you sent 42 emails" || len(out.ToolCalls) != 1 || out.ToolCalls[0].Tool != "stat_read" {
		t.Fatalf("unexpected result: %+v", out)
	}
}

func TestChatHandler_unauthenticated(t *testing.T) {
	h := &ChatHandler{Registry: handlerReg(t), Governor: protectedTestGovernor{}, LLM: &scriptedLLM{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-agent/chat", strings.NewReader(`{"message":"hi"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req) // no tenant on ctx
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 without a tenant, got %d", rec.Code)
	}
}

func TestChatHandler_sseStream(t *testing.T) {
	llm := &scriptedLLM{responses: []*LLMResponse{
		wantTool(toolUse("t1", "stat_read", `{}`)),
		endTurn("done"),
	}}
	h := &ChatHandler{Registry: handlerReg(t), Governor: protectedTestGovernor{}, LLM: llm}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authedRequest(`{"message":"go"}`, "text/event-stream"))

	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("want SSE content-type, got %q", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{`"type":"tool_call"`, `"type":"tool_result"`, `"type":"result"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("SSE stream missing %s; got:\n%s", want, body)
		}
	}
}

func TestChatHandler_missingMessage(t *testing.T) {
	h := &ChatHandler{Registry: handlerReg(t), Governor: protectedTestGovernor{}, LLM: &scriptedLLM{}}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authedRequest(`{}`, ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for missing message, got %d", rec.Code)
	}
}

func TestChatHandler_BYOKFailureNeverCallsPlatformLLM(t *testing.T) {
	platform := &scriptedLLM{}
	h := &ChatHandler{
		Registry: handlerReg(t),
		Governor: protectedTestGovernor{},
		LLM:      platform,
		LLMFor: func(context.Context) (LLMClient, error) {
			return nil, errors.New("tenant key decrypt failed")
		},
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authedRequest(`{"message":"private customer prompt"}`, ""))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d: %s", rec.Code, rec.Body.String())
	}
	if platform.calls != 0 {
		t.Fatalf("privacy boundary violated: platform LLM called %d times", platform.calls)
	}
}

func TestChatHandler_AbsentBYOKMayUsePlatformLLM(t *testing.T) {
	platform := &scriptedLLM{}
	h := &ChatHandler{
		Registry: handlerReg(t),
		Governor: protectedTestGovernor{},
		LLM:      platform,
		LLMFor: func(context.Context) (LLMClient, error) {
			return nil, nil
		},
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authedRequest(`{"message":"hello"}`, ""))
	if rec.Code != http.StatusOK || platform.calls != 1 {
		t.Fatalf("absent key should use platform: code=%d calls=%d body=%s", rec.Code, platform.calls, rec.Body.String())
	}
}
