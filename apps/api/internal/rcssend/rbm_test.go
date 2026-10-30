// SPDX-License-Identifier: AGPL-3.0-only
package rcssend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRBMAdapter_NotConfiguredWithoutCreds(t *testing.T) {
	a := &RBMAdapter{}
	if a.Configured() {
		t.Fatalf("a zero-value adapter must not report configured")
	}
	_, err := a.SendRCS(context.Background(), "+15551234567", "hi", nil)
	if err == nil || !strings.Contains(err.Error(), "RBM agent not configured") {
		t.Fatalf("expected 'RBM agent not configured', got %v", err)
	}
}

func TestRBMAdapter_NotConfiguredMissingAgentID(t *testing.T) {
	a := &RBMAdapter{TokenSource: StaticToken("tok")}
	if a.Configured() {
		t.Fatalf("missing AgentID must not be configured")
	}
	_, err := a.SendRCS(context.Background(), "+15551234567", "hi", nil)
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("expected not-configured error, got %v", err)
	}
}

func TestRBMAdapter_NotConfiguredFromEnvWithoutVars(t *testing.T) {
	t.Setenv("RBM_AGENT_ID", "")
	t.Setenv("RBM_ACCESS_TOKEN", "")
	a := NewRBMAdapterFromEnv()
	if a.Configured() {
		t.Fatalf("expected NewRBMAdapterFromEnv() with no env vars to be unconfigured")
	}
}

func TestRBMAdapter_SendsRealRequestShape(t *testing.T) {
	var gotPath, gotAuth, gotAgentID string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAgentID = r.URL.Query().Get("agentId")
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"name":"ok"}`))
	}))
	defer srv.Close()

	a := &RBMAdapter{
		AgentID:     "agent-123",
		TokenSource: StaticToken("secret-token"),
		BaseURL:     srv.URL,
	}
	delivered, err := a.SendRCS(context.Background(), "+15551234567", "hello there", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !delivered {
		t.Fatalf("expected delivered=true on HTTP 200")
	}
	if gotPath != "/phones/+15551234567/agentMessages" {
		t.Fatalf("unexpected path: %q", gotPath)
	}
	if gotAgentID != "agent-123" {
		t.Fatalf("agentId not sent: %q", gotAgentID)
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("bearer token not sent: %q", gotAuth)
	}
	content, _ := gotBody["contentMessage"].(map[string]any)
	if content == nil || content["text"] != "hello there" {
		t.Fatalf("expected message text in contentMessage, got %+v", gotBody)
	}
	if gotBody["messageId"] == nil || gotBody["messageId"] == "" {
		t.Fatalf("expected a generated messageId, got %+v", gotBody)
	}
}

func TestRBMAdapter_SendsRichCardWhenProvided(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"name":"ok"}`))
	}))
	defer srv.Close()

	a := &RBMAdapter{AgentID: "agent-123", TokenSource: StaticToken("tok"), BaseURL: srv.URL}
	_, err := a.SendRCS(context.Background(), "+1", "", map[string]any{"title": "Track your order"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	content, _ := gotBody["contentMessage"].(map[string]any)
	if content == nil || content["richCard"] == nil {
		t.Fatalf("expected richCard in contentMessage, got %+v", gotBody)
	}
	if _, hasText := content["text"]; hasText {
		t.Fatalf("text must be omitted when a rich card is sent, got %+v", content)
	}
}

func TestRBMAdapter_UpstreamErrorSurfacesDetail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"message":"agent not verified","status":"PERMISSION_DENIED"}}`))
	}))
	defer srv.Close()

	a := &RBMAdapter{AgentID: "agent-123", TokenSource: StaticToken("tok"), BaseURL: srv.URL}
	delivered, err := a.SendRCS(context.Background(), "+1", "hi", nil)
	if delivered {
		t.Fatalf("expected delivered=false on a 403")
	}
	if err == nil || !strings.Contains(err.Error(), "agent not verified") {
		t.Fatalf("expected upstream error detail to surface, got %v", err)
	}
}

func TestRBMAdapter_TokenSourceErrorIsNotConfigured(t *testing.T) {
	a := &RBMAdapter{
		AgentID:     "agent-123",
		TokenSource: func(context.Context) (string, error) { return "", context.DeadlineExceeded },
	}
	_, err := a.SendRCS(context.Background(), "+1", "hi", nil)
	if err == nil || !strings.Contains(err.Error(), "token source") {
		t.Fatalf("expected token source error to surface, got %v", err)
	}
}

func TestStaticToken_EmptyIsNilSource(t *testing.T) {
	if StaticToken("") != nil {
		t.Fatalf("StaticToken(\"\") must be nil so Configured() is false")
	}
	if StaticToken("  ") != nil {
		t.Fatalf("StaticToken of whitespace-only must be nil")
	}
	ts := StaticToken(" tok ")
	tok, err := ts(context.Background())
	if err != nil || tok != "tok" {
		t.Fatalf("expected trimmed token, got %q err=%v", tok, err)
	}
}
