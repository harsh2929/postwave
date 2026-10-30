// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// thinkingLLM holds its first round until the test releases it, the way a
// model does while it reasons with nothing to emit.
type thinkingLLM struct {
	release chan struct{}
}

func (l *thinkingLLM) Message(ctx context.Context, _ string, _ []LLMMessage, _ []ToolDefn) (*LLMResponse, error) {
	select {
	case <-l.release:
		return endTurn("done"), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// A round that emits nothing for longer than the load balancer's idle window
// was cut by the balancer. The stream must carry a heartbeat while the model
// thinks, over a real connection, and still end with the run's result.
func TestChatHandler_sseHeartbeatsWhileTheModelThinks(t *testing.T) {
	previous := chatHeartbeatInterval
	chatHeartbeatInterval = 20 * time.Millisecond
	t.Cleanup(func() { chatHeartbeatInterval = previous })

	llm := &thinkingLLM{release: make(chan struct{})}
	h := &ChatHandler{Registry: handlerReg(t), Governor: protectedTestGovernor{}, LLM: llm}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1", Slug: "acme"})
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		h.ServeHTTP(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/ai-agent/chat", strings.NewReader(`{"message":"think"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	next := func(want func(string) bool, what string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("stream ended before %s", what)
				}
				if want(line) {
					return
				}
			case <-deadline:
				t.Fatalf("no %s within 3s", what)
			}
		}
	}

	next(func(line string) bool { return strings.Contains(line, `"type":"ai_disclosure"`) }, "disclosure frame")
	// The model has not answered: only a heartbeat can arrive now.
	next(func(line string) bool { return line == ": heartbeat" }, "heartbeat while the model thinks")
	close(llm.release)
	next(func(line string) bool { return strings.Contains(line, `"type":"result"`) }, "result frame")
}
