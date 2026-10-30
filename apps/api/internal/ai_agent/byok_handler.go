// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the per-tenant BYOK LLM provider config (3.3b). These
// close the loop on the BYOK feature: LLMConfigRepo.Set persists an
// encrypted provider key, NewBYOKResolver (wired into ChatHandler.LLMFor)
// reads it per request. Without these routes the resolver would be inert
// (no way to populate the config). The plaintext key is NEVER returned.
package ai_agent

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const llmConfigMaxBody = 8 << 10

// llmConfigStore is the read+write surface the BYOK config routes need
// (satisfied by *LLMConfigRepo). Kept separate from LLMConfigStore (read-only,
// used by NewBYOKResolver) so the resolver's fakes don't have to implement
// Set, and so these handlers are unit-testable with a fake.
type llmConfigStore interface {
	Get(ctx context.Context, tenantID string) (*LLMConfig, error)
	Set(ctx context.Context, tenantID, provider, model, plaintextKey string) error
}

// getLLMConfig GET /api/v1/ai-agent/config — reports whether a per-tenant
// BYOK LLM key is configured plus the provider/model. The API key itself is
// never returned.
func (h *ChatHandler) getLLMConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	if h.LLMConfig == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "byok llm config is not available"})
		return
	}
	cfg, err := h.LLMConfig.Get(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not read config"})
		return
	}
	if cfg == nil {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"provider":   cfg.Provider,
		"model":      cfg.Model,
		// api key intentionally never returned.
	})
}

// setLLMConfig PUT /api/v1/ai-agent/config — stores the tenant's BYOK LLM
// provider key (encrypted at rest via the byok Composite cipher). Body:
// {provider, model, api_key}. Admin-scoped at the mount point.
func (h *ChatHandler) setLLMConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return
	}
	if h.LLMConfig == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "byok llm config is not available"})
		return
	}
	var in struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		APIKey   string `json:"api_key"`
	}
	if err := httpbody.DecodeJSON(w, r, llmConfigMaxBody, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	provider, err := normalizeLLMProvider(in.Provider)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "provider must be anthropic"})
		return
	}
	if strings.TrimSpace(in.APIKey) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "api_key is required"})
		return
	}
	if err := h.LLMConfig.Set(r.Context(), t.ID, provider, in.Model, in.APIKey); err != nil {
		if errors.Is(err, ErrUnsupportedLLMProvider) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "provider must be anthropic"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not save config"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
