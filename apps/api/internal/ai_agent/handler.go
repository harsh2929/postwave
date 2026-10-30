// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

const chatMaxBodyBytes int64 = 256 << 10 // 256 KiB (message + history)

// agentRunTimeout bounds a whole chat run (all tool iterations) so a slow
// provider can never hang the request indefinitely.
const agentRunTimeout = 4 * time.Minute

// ChatHandler serves the in-app agent at POST /api/v1/ai-agent/chat. It runs
// the governed ToolLoop and returns either a single JSON RunResult or, when
// the client sends Accept: text/event-stream, an SSE stream of progress
// events (tool_call / tool_result / final) followed by a terminal result.
//
// It is mounted inside the authenticated API group, so the request context
// already carries the tenant + scopes (+ sandbox flag) the chokepoint reads
// — the agent runs with exactly the caller's authority.
type ChatHandler struct {
	Registry      *agenttools.Registry
	Governor      agenttools.Governor
	LLM           LLMClient
	System        string
	MaxIterations int
	// LLMFor, when set, selects the LLM client per request (the seam where
	// per-tenant BYOK provider config plugs in). It takes precedence over
	// LLM. A nil client with no error means no tenant key and permits the
	// platform fallback; an error is a privacy boundary and fails closed.
	LLMFor func(ctx context.Context) (LLMClient, error)
	// CostRecorder attributes a run's token usage to the tenant (cost ledger).
	CostRecorder func(ctx context.Context, caller agenttools.Caller, usage TokenUsage)
	// Sessions, when set, persists conversations. The route family is
	// release-held before this interface while tenant-wide session ownership
	// and retention are unqualified; keeping the seam preserves testable future
	// reachability without letting the held mount touch storage.
	Sessions AgentSessionStore
	// LLMConfig, when set, backs the per-tenant BYOK provider config routes
	// (GET/PUT /api/v1/ai-agent/config) so a tenant can store/read which
	// provider key the agent should use. The stored key feeds LLMFor (via
	// NewBYOKResolver). nil → the config routes are not mounted. An interface
	// (satisfied by *LLMConfigRepo) so the handlers are unit-testable.
	LLMConfig llmConfigStore
}

// AgentSessionStore is the persistence seam used by the future session
// handlers. The production Repo satisfies it; the release-hold mount must not
// invoke any method.
type AgentSessionStore interface {
	CreateSession(ctx context.Context, tenantID, title string, createdByUser *string) (*Session, error)
	GetSession(ctx context.Context, tenantID, sessionID string) (*Session, error)
	ListSessions(ctx context.Context, tenantID string, limit int) ([]Session, error)
	AppendMessage(ctx context.Context, tenantID string, message Message) (*Message, error)
	ListMessages(ctx context.Context, tenantID, sessionID string) ([]Message, error)
}

// resolveLLM picks the client for this request: per-tenant (BYOK) when a
// resolver is wired and returns one, else the default client.
func (h *ChatHandler) resolveLLM(ctx context.Context) (LLMClient, error) {
	if h.LLMFor != nil {
		c, err := h.LLMFor(ctx)
		if err != nil {
			return nil, err
		}
		if c != nil {
			return c, nil
		}
	}
	return h.LLM, nil
}

type chatRequest struct {
	Message       string       `json:"message"`
	History       []LLMMessage `json:"history,omitempty"`
	MaxIterations int          `json:"max_iterations,omitempty"`
}

func (h *ChatHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
		return
	}
	if h.Registry == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent is not configured"})
		return
	}
	if t, ok := middleware.TenantFromContext(r.Context()); !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	if !agenttools.LLMResultProtectionReady(h.Governor) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent result-protection governor is not configured"})
		return
	}
	llm, err := h.resolveLLM(r.Context())
	if err != nil {
		slog.Warn("ai-agent: tenant LLM resolution failed closed", "err", err.Error())
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "tenant LLM configuration is temporarily unavailable"})
		return
	}
	if llm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent is not configured (no LLM provider)"})
		return
	}

	var in chatRequest
	if err := httpbody.DecodeJSON(w, r, chatMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if strings.TrimSpace(in.Message) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "message is required"})
		return
	}

	caller := callerFromContext(r)
	loop := &ToolLoop{
		Registry:      h.Registry,
		Governor:      h.Governor,
		LLM:           llm,
		System:        h.System,
		MaxIterations: firstPositive(in.MaxIterations, h.MaxIterations),
		CostRecorder:  h.CostRecorder,
	}

	ctx, cancel := context.WithTimeout(r.Context(), agentRunTimeout)
	defer cancel()

	if wantsSSE(r) {
		h.serveSSE(w, ctx, cancel, loop, caller, in)
		return
	}
	res, err := loop.Run(ctx, caller, in.History, in.Message)
	if err != nil {
		// Never leak upstream provider detail to the client; log it server-side.
		slog.Warn("ai-agent: run failed", "err", err.Error())
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the agent could not complete the request"})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// chatHeartbeatInterval spaces the comment frames serveSSE writes while a run
// has nothing to emit. It sits well inside the staging load balancer's
// 100-second idle timeout and inside sse.WriteWindow. A variable so a test
// can observe a heartbeat without waiting for one.
var chatHeartbeatInterval = 30 * time.Second

func (h *ChatHandler) serveSSE(w http.ResponseWriter, ctx context.Context, cancel context.CancelFunc, loop *ToolLoop, caller agenttools.Caller, in chatRequest) {
	stream, ok := sse.Open(w)
	if !ok {
		// No streaming support — single JSON response.
		res, err := loop.Run(ctx, caller, in.History, in.Message)
		if err != nil {
			slog.Warn("ai-agent: run failed", "err", err.Error())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the agent could not complete the request"})
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}
	// Every frame goes through the stream, which moves the server write
	// deadline forward before writing, so a long multi-round run isn't
	// truncated mid-stream by the HTTP server's WriteTimeout.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// The heartbeat below writes from its own goroutine while the tool loop
	// emits frames, and a ResponseWriter is not safe for concurrent use.
	var writeMu sync.Mutex
	writeFrame := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			return
		}
		frame := append([]byte("data: "), b...)
		frame = append(frame, '\n', '\n')
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, werr := stream.Write(frame); werr != nil || stream.Flush() != nil {
			// Client disconnected — stop the governed (and possibly
			// send-charging) run at the next checkpoint rather than churning.
			cancel()
		}
	}

	// A model round can take longer than the load balancer's idle window
	// with nothing to emit; a comment frame every heartbeat keeps bytes on
	// the connection (and the write deadline moving) until the run ends.
	// The goroutine is stopped and waited for before the handler returns:
	// nothing may write to w after that.
	stopHeartbeat := make(chan struct{})
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(chatHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				writeMu.Lock()
				err := stream.Sendf(": heartbeat\n\n")
				writeMu.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		close(stopHeartbeat)
		<-heartbeatDone
	}()

	// Article 50(1): disclose that this is an AI before anything it generates.
	//
	// The EU AI Act, in force 2 August 2026, requires a system interacting with
	// a natural person to disclose that fact, and `internal/aidisclosure`'s
	// package doc names the in-app agent as exactly that case. `aicompose`
	// already marks its generated bodies and sets the delivery header; this
	// surface — the one the regulation names most directly — referenced the
	// package nowhere.
	//
	// FIRST frame, deliberately. A notice that arrives after the answer has not
	// disclosed anything, and the constant is used rather than the wording
	// copied so a change by counsel lands in one place.
	writeFrame(map[string]any{
		"type":         "ai_disclosure",
		"text":         aidisclosure.DisclosureText,
		"ai_generated": true,
	})
	loop.Emit = func(ev AgentEvent) { writeFrame(ev) }

	res, err := loop.Run(ctx, caller, in.History, in.Message)
	if err != nil {
		slog.Warn("ai-agent: sse run failed", "err", err.Error())
		writeFrame(map[string]any{"type": "error", "error": "the agent could not complete the request"})
		return
	}
	writeFrame(map[string]any{"type": "result", "result": res})
}

// callerFromContext builds the agent-surface Caller from the authenticated
// request context. Scopes are NOT copied here — Execute reads them from ctx,
// the one authorization source. Sandbox is honored from EITHER the per-key
// flag OR the X-Postwave-Sandbox request header (header can only add safety).
func callerFromContext(r *http.Request) agenttools.Caller {
	ctx := r.Context()
	c := agenttools.Caller{
		Surface:   agenttools.SurfaceAgent,
		LLMFacing: true,
		Sandbox:   sandbox.IsSandboxRequest(r) || sandbox.IsFlagged(ctx),
		APIKeyID:  middleware.APIKeyIDFromContext(ctx),
	}
	if t, ok := middleware.TenantFromContext(ctx); ok && t != nil {
		c.TenantID = t.ID
	}
	c.ActorType, c.ActorLabel = middleware.ActorFromContext(ctx)
	if c.ActorType == "" {
		c.ActorType = "agent"
	}
	return c
}

func wantsSSE(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream")
}

func firstPositive(vals ...int) int {
	for _, v := range vals {
		if v > 0 {
			return v
		}
	}
	return 0
}

// ServeSessionChat runs one agent turn within a persisted session
// (POST /api/v1/ai-agent/sessions/{id}/chat). Prior turns are loaded from
// storage as history (the durable, resumable surface), the user + assistant
// turns are persisted, and token usage is recorded on the assistant message.
// JSON only — clients wanting live progress use the stateless SSE /chat.
func (h *ChatHandler) ServeSessionChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
		return
	}
	if h.Registry == nil || h.Sessions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent is not configured"})
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	if !agenttools.LLMResultProtectionReady(h.Governor) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent result-protection governor is not configured"})
		return
	}
	llm, err := h.resolveLLM(r.Context())
	if err != nil {
		slog.Warn("ai-agent: tenant LLM resolution failed closed", "err", err.Error())
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "tenant LLM configuration is temporarily unavailable"})
		return
	}
	if llm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the in-app agent is not configured (no LLM provider)"})
		return
	}
	sessionID := chi.URLParam(r, "id")
	if _, err := h.Sessions.GetSession(r.Context(), t.ID, sessionID); err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
			return
		}
		slog.Warn("ai-agent: load session", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not load the session"})
		return
	}

	var in chatRequest
	if err := httpbody.DecodeJSON(w, r, chatMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if strings.TrimSpace(in.Message) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "message is required"})
		return
	}

	// Load prior turns from storage as history (server-trusted, unlike the
	// stateless path's client-supplied history).
	prior, err := h.Sessions.ListMessages(r.Context(), t.ID, sessionID)
	if err != nil {
		slog.Warn("ai-agent: load messages", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not load conversation history"})
		return
	}
	history := messagesToHistory(prior)

	// Persist the user turn before running (so it's recorded even if the run
	// fails midway).
	if _, err := h.Sessions.AppendMessage(r.Context(), t.ID, Message{SessionID: sessionID, Role: RoleUser, Body: in.Message}); err != nil {
		slog.Warn("ai-agent: persist user message", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not save the message"})
		return
	}

	caller := callerFromContext(r)
	loop := &ToolLoop{
		Registry:      h.Registry,
		Governor:      h.Governor,
		LLM:           llm,
		System:        h.System,
		MaxIterations: firstPositive(in.MaxIterations, h.MaxIterations),
		CostRecorder:  h.CostRecorder,
	}
	ctx, cancel := context.WithTimeout(r.Context(), agentRunTimeout)
	defer cancel()
	res, err := loop.Run(ctx, caller, history, in.Message)
	if err != nil {
		slog.Warn("ai-agent: session run failed", "err", err.Error())
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the agent could not complete the request"})
		return
	}

	// Persist the assistant turn with token usage for the cost ledger.
	inTok, outTok := res.Usage.InputTokens, res.Usage.OutputTokens
	if _, err := h.Sessions.AppendMessage(r.Context(), t.ID, Message{
		SessionID: sessionID, Role: RoleAssistant, Body: res.Text,
		InputTokens: &inTok, OutputTokens: &outTok,
	}); err != nil {
		slog.Warn("ai-agent: persist assistant message", "err", err.Error())
		// The run succeeded; report it even if persistence of the reply failed.
	}

	writeJSON(w, http.StatusOK, map[string]any{"session_id": sessionID, "result": res})
}

// messagesToHistory converts persisted turns into LLM history, keeping only
// the user/assistant text turns (tool turns are reconstructed by the loop).
func messagesToHistory(msgs []Message) []LLMMessage {
	out := make([]LLMMessage, 0, len(msgs))
	for _, m := range msgs {
		if (m.Role != RoleUser && m.Role != RoleAssistant) || strings.TrimSpace(m.Body) == "" {
			continue
		}
		out = append(out, LLMMessage{Role: m.Role, Content: []LLMContent{{Type: "text", Text: m.Body}}})
	}
	return out
}

// writeJSON is defined in campaign.go (same package) and reused here.
