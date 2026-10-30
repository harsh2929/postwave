// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AgentInteractiveReleaseHoldCode is the stable response code for the entire
// in-app agent route family while session ownership, retention, and the wider
// runtime/governance boundary remain unqualified.
const AgentInteractiveReleaseHoldCode = "agent_interactive_release_held"

// AgentInteractiveReleased is deliberately compile-time false. The future
// handlers remain below for review, but no request may reach auth-specific
// middleware, repositories, configuration stores, or an LLM provider.
const AgentInteractiveReleased = false

// MountAgentRoutes mounts a fail-closed boundary over every current and future
// /api/v1/ai-agent path and method. The implementation below the boundary is
// retained so a future, separately reviewed release can restore reachability.
//
// This supersedes campaign.go's MountRoutes (the deterministic, never-
// LLM-calling plan stub + its /confirm 503), which is retained only as
// dead code pending removal and is not mounted anywhere.
//
// Gated like the native MCP endpoint (API key + ScopeMCP): the agent is a
// programmatic surface, and per-tool scopes are enforced inside Execute.
func MountAgentRoutes(r chi.Router, h *ChatHandler) {
	if !AgentInteractiveReleased {
		MountAgentReleaseHoldRoutes(r)
		return
	}
	if h == nil || h.Registry == nil {
		return
	}
	r.Group(func(r chi.Router) {
		r.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodAPIKey))
		r.Use(apikeys.RequireScope(apikeys.ScopeMCP))

		// Stateless one-shot (supports SSE).
		r.Post("/api/v1/ai-agent/chat", h.ServeHTTP)

		if h.Sessions != nil {
			// Durable, resumable sessions.
			r.Post("/api/v1/ai-agent/sessions", h.createSession)
			r.Get("/api/v1/ai-agent/sessions", h.listSessions)
			r.Get("/api/v1/ai-agent/sessions/{id}/messages", h.listSessionMessages)
			r.Post("/api/v1/ai-agent/sessions/{id}/chat", h.ServeSessionChat)
		}
	})
	// Per-tenant BYOK LLM provider config (3.3b). Admin-scoped: PUT writes a
	// provider credential, so it requires a stronger scope than the
	// agent-runtime ScopeMCP. Mounted only when the config store is wired.
	if h.LLMConfig != nil {
		r.Group(func(r chi.Router) {
			r.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodAPIKey))
			r.Use(apikeys.RequireScope(apikeys.ScopeAdmin))
			r.Get("/api/v1/ai-agent/config", h.getLLMConfig)
			r.Put("/api/v1/ai-agent/config", h.setLLMConfig)
		})
	}
}

// MountAgentReleaseHoldRoutes must be called on the outer router, before the
// authenticated route group. Mounting it inside that group would let API-key
// parsing, tenant/session lookup, telemetry recording, idempotency, audit, and
// cost middleware run before the hold.
func MountAgentReleaseHoldRoutes(r chi.Router) {
	hold := http.HandlerFunc(agentInteractiveReleaseHold)
	r.Handle("/api/v1/ai-agent", hold)
	r.Handle("/api/v1/ai-agent/*", hold)
}

func agentInteractiveReleaseHold(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{
		Error: "the in-app agent is release-held",
		Code:  AgentInteractiveReleaseHoldCode,
	})
}

func (h *ChatHandler) createSession(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := httpbody.DecodeJSONWith(w, r, 8<<10, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "New conversation"
	}
	s, err := h.Sessions.CreateSession(r.Context(), t.ID, title, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not create session"})
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

func (h *ChatHandler) listSessions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	out, err := h.Sessions.ListSessions(r.Context(), t.ID, 50)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not list sessions"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (h *ChatHandler) listSessionMessages(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	out, err := h.Sessions.ListMessages(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not list messages"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}
