// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeLLMConfigStore struct {
	getCfg                        *LLMConfig
	getErr                        error
	setErr                        error
	setCalled                     bool
	setProvider, setModel, setKey string
}

func (f *fakeLLMConfigStore) Get(context.Context, string) (*LLMConfig, error) {
	return f.getCfg, f.getErr
}

func (f *fakeLLMConfigStore) Set(_ context.Context, _, provider, model, key string) error {
	f.setCalled, f.setProvider, f.setModel, f.setKey = true, provider, model, key
	return f.setErr
}

func byokReq(method, body string, tenant bool) *http.Request {
	r := httptest.NewRequest(method, "/api/v1/ai-agent/config", strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if tenant {
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	}
	return r
}

func TestGetLLMConfig(t *testing.T) {
	t.Run("nil store -> 503", func(t *testing.T) {
		w := httptest.NewRecorder()
		(&ChatHandler{}).getLLMConfig(w, byokReq("GET", "", true))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("code=%d", w.Code)
		}
	})
	t.Run("no tenant -> 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		(&ChatHandler{LLMConfig: &fakeLLMConfigStore{}}).getLLMConfig(w, byokReq("GET", "", false))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("code=%d", w.Code)
		}
	})
	t.Run("unconfigured -> configured:false", func(t *testing.T) {
		w := httptest.NewRecorder()
		(&ChatHandler{LLMConfig: &fakeLLMConfigStore{getCfg: nil}}).getLLMConfig(w, byokReq("GET", "", true))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"configured":false`) {
			t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("configured -> provider/model but NEVER the key", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{getCfg: &LLMConfig{Provider: "anthropic", Model: "claude-x", APIKey: "sk-secret-DO-NOT-LEAK"}}
		(&ChatHandler{LLMConfig: store}).getLLMConfig(w, byokReq("GET", "", true))
		body := w.Body.String()
		if w.Code != http.StatusOK || !strings.Contains(body, `"configured":true`) || !strings.Contains(body, "anthropic") {
			t.Fatalf("code=%d body=%s", w.Code, body)
		}
		if strings.Contains(body, "sk-secret") {
			t.Fatalf("PLAINTEXT KEY LEAKED in GET response: %s", body)
		}
	})
}

func TestSetLLMConfig(t *testing.T) {
	t.Run("nil store -> 503", func(t *testing.T) {
		w := httptest.NewRecorder()
		(&ChatHandler{}).setLLMConfig(w, byokReq("PUT", `{"api_key":"x"}`, true))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("code=%d", w.Code)
		}
	})
	t.Run("missing api_key -> 400, Set not called", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{}
		(&ChatHandler{LLMConfig: store}).setLLMConfig(w, byokReq("PUT", `{"provider":"anthropic"}`, true))
		if w.Code != http.StatusBadRequest || store.setCalled {
			t.Fatalf("code=%d setCalled=%v", w.Code, store.setCalled)
		}
	})
	t.Run("unsupported provider -> 400, Set not called", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{}
		(&ChatHandler{LLMConfig: store}).setLLMConfig(w, byokReq("PUT", `{"provider":"openai","api_key":"sk-openai"}`, true))
		if w.Code != http.StatusBadRequest || store.setCalled {
			t.Fatalf("code=%d setCalled=%v body=%s", w.Code, store.setCalled, w.Body.String())
		}
	})
	t.Run("invalid JSON -> 400, Set not called", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{}
		(&ChatHandler{LLMConfig: store}).setLLMConfig(w, byokReq("PUT", `{`, true))
		if w.Code != http.StatusBadRequest || store.setCalled {
			t.Fatalf("code=%d setCalled=%v body=%s", w.Code, store.setCalled, w.Body.String())
		}
	})
	t.Run("happy -> 204 and key forwarded to Set", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{}
		(&ChatHandler{LLMConfig: store}).setLLMConfig(w, byokReq("PUT", `{"provider":"anthropic","model":"m","api_key":"sk-123"}`, true))
		if w.Code != http.StatusNoContent {
			t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
		}
		if !store.setCalled || store.setKey != "sk-123" || store.setProvider != "anthropic" || store.setModel != "m" {
			t.Fatalf("Set got provider=%q model=%q key=%q called=%v", store.setProvider, store.setModel, store.setKey, store.setCalled)
		}
		// The response body must not echo the key.
		if strings.Contains(w.Body.String(), "sk-123") {
			t.Fatalf("key leaked in PUT response: %s", w.Body.String())
		}
	})
	t.Run("store error -> 500", func(t *testing.T) {
		w := httptest.NewRecorder()
		store := &fakeLLMConfigStore{setErr: context.DeadlineExceeded}
		(&ChatHandler{LLMConfig: store}).setLLMConfig(w, byokReq("PUT", `{"api_key":"sk-1"}`, true))
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("code=%d", w.Code)
		}
	})
}
