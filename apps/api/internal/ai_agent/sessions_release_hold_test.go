// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type holdSessionStore struct{ calls int }

func (s *holdSessionStore) CreateSession(context.Context, string, string, *string) (*Session, error) {
	s.calls++
	return &Session{}, nil
}
func (s *holdSessionStore) GetSession(context.Context, string, string) (*Session, error) {
	s.calls++
	return &Session{}, nil
}
func (s *holdSessionStore) ListSessions(context.Context, string, int) ([]Session, error) {
	s.calls++
	return nil, nil
}
func (s *holdSessionStore) AppendMessage(context.Context, string, Message) (*Message, error) {
	s.calls++
	return &Message{}, nil
}
func (s *holdSessionStore) ListMessages(context.Context, string, string) ([]Message, error) {
	s.calls++
	return nil, nil
}

type holdConfigStore struct{ calls int }

func (s *holdConfigStore) Get(context.Context, string) (*LLMConfig, error) {
	s.calls++
	return &LLMConfig{}, nil
}
func (s *holdConfigStore) Set(context.Context, string, string, string, string) error {
	s.calls++
	return nil
}

type holdLLM struct{ calls int }

func (l *holdLLM) Message(context.Context, string, []LLMMessage, []ToolDefn) (*LLMResponse, error) {
	l.calls++
	return &LLMResponse{StopReason: "end_turn"}, nil
}

type holdGovernor struct{ agenttools.NoopGovernor }

func (holdGovernor) LLMResultProtectionReady() bool { return true }

func TestMountAgentRoutesReleaseHoldCoversFamilyBeforeSideEffects(t *testing.T) {
	if AgentInteractiveReleased {
		t.Fatal("test requires the agent route family release hold")
	}
	sessions := &holdSessionStore{}
	config := &holdConfigStore{}
	provider := &holdLLM{}
	resolverCalls := 0
	costCalls := 0
	h := &ChatHandler{
		Registry: agenttools.NewRegistry(),
		Governor: holdGovernor{},
		LLMFor: func(context.Context) (LLMClient, error) {
			resolverCalls++
			return provider, nil
		},
		CostRecorder: func(context.Context, agenttools.Caller, TokenUsage) {
			costCalls++
		},
		Sessions:  sessions,
		LLMConfig: config,
	}
	router := chi.NewRouter()
	MountAgentRoutes(router, h)

	routes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/v1/ai-agent/chat", `{"message":"private-chat-secret"}`},
		{http.MethodGet, "/api/v1/ai-agent/sessions", ""},
		{http.MethodPost, "/api/v1/ai-agent/sessions", `{"title":"private-title-secret"}`},
		{http.MethodGet, "/api/v1/ai-agent/sessions/session-secret/messages", ""},
		{http.MethodPost, "/api/v1/ai-agent/sessions/session-secret/chat", `{"message":"private-session-secret"}`},
		{http.MethodGet, "/api/v1/ai-agent/config", ""},
		{http.MethodPut, "/api/v1/ai-agent/config", `{"provider":"anthropic","api_key":"private-provider-secret"}`},
		{http.MethodDelete, "/api/v1/ai-agent/future-route", ""},
		{http.MethodPatch, "/api/v1/ai-agent/chat", `{"message":"private-method-secret"}`},
	}
	authModes := []string{"none", "api_key", "session"}
	for _, route := range routes {
		for _, authMode := range authModes {
			t.Run(authMode+"_"+route.method+"_"+route.path, func(t *testing.T) {
				req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				req.Header.Set("Accept", "text/event-stream")
				ctx := req.Context()
				switch authMode {
				case "api_key":
					ctx = middleware.WithAPIKeyAuth(ctx)
					ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-api"})
				case "session":
					ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-1", TenantID: "tenant-session", Role: "owner"})
					ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-session"})
				}
				req = req.WithContext(ctx)
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)

				if rec.Code != http.StatusServiceUnavailable {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
				if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
					t.Fatalf("Cache-Control=%q", got)
				}
				if got := rec.Header().Get("Pragma"); got != "no-cache" {
					t.Fatalf("Pragma=%q", got)
				}
				if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
					t.Fatalf("Content-Type=%q", got)
				}
				var frame struct {
					Error string `json:"error"`
					Code  string `json:"code"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &frame); err != nil {
					t.Fatalf("decode hold frame: %v", err)
				}
				if frame.Code != AgentInteractiveReleaseHoldCode || frame.Error != "the in-app agent is release-held" {
					t.Fatalf("frame=%+v", frame)
				}
				if strings.Contains(rec.Body.String(), "private-") || strings.Contains(rec.Body.String(), "session-secret") {
					t.Fatalf("request detail escaped hold frame: %s", rec.Body.String())
				}
			})
		}
	}

	if sessions.calls != 0 || config.calls != 0 || resolverCalls != 0 || provider.calls != 0 || costCalls != 0 {
		t.Fatalf("held route invoked side effects: sessions=%d config=%d resolver=%d provider=%d cost=%d",
			sessions.calls, config.calls, resolverCalls, provider.calls, costCalls)
	}
}
