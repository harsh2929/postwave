// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountRoutes registers the admin surface for the native MCP server.
// All endpoints are admin-gated so only owners/admins can flip the
// surface on/off or shrink the allowlist.
//
//	GET    /api/v1/mcp/server/settings  → fetch current settings
//	PATCH  /api/v1/mcp/server/settings  → update settings
//	GET    /api/v1/mcp/server/catalog   → list the built-in tool catalog
//	GET    /api/v1/mcp/server/calls     → recent call log (≤200 rows)
//
// The RPC endpoint itself (POST /api/v1/mcp/rpc) is wired by main.go
// alongside this since it has a slightly different scope gate (any
// authenticated API key, not just admin).
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeycalls.ProtectMCPResponses, apikeys.RequireExactTenantAdmin).
		Get("/api/v1/mcp/server/settings", d.GetSettings)
	r.With(apikeycalls.ProtectMCPResponses, apikeys.RequireExactTenantAdmin).
		Patch("/api/v1/mcp/server/settings", d.PatchSettings)
	r.With(apikeycalls.ProtectMCPResponses, apikeys.RequireExactTenantAdmin).
		Get("/api/v1/mcp/server/catalog", d.GetCatalog)
	r.With(apikeycalls.ProtectMCPResponses, apikeys.RequireExactTenantAdmin).
		Get("/api/v1/mcp/server/calls", d.ListCalls)
}

// GetSettings returns the per-tenant MCP server config. Lazily
// creates the row with defaults (enabled=true, write_enabled=false)
// on first read.
func (d *Deps) GetSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	s, err := d.loadOrInitSettings(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "load_failed", "message": "an internal error occurred"},
		})
		return
	}
	applyWriteTierReleasePolicy(s)
	writeJSON(w, http.StatusOK, s)
}

// PatchSettings applies a partial update.
func (d *Deps) PatchSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	var in UpdateSettingsInput
	if err := httpbody.DecodeJSONWith(w, r, 16*1024, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		writeJSON(w, httpbody.StatusCode(err), map[string]any{
			"error": map[string]string{"code": httpbody.ErrorCode(err), "message": httpbody.PublicMessage(err)},
		})
		return
	}
	if in.WriteEnabled != nil && *in.WriteEnabled && !NativeWriteTierReleased {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]string{
				"code":    NativeWriteTierReleaseHoldCode,
				"message": "MCP write-tier activation is release-held until mutations, budgets, and audit evidence share a durable boundary",
			},
		})
		return
	}
	// If the operator supplied an allowlist, verify each entry maps
	// to a known tool — otherwise the dashboard could nominate a
	// typo'd tool name that would silently hide the entire surface.
	if in.AllowedTools != nil {
		known := map[string]struct{}{}
		for _, t := range d.allTools() {
			known[t.Name] = struct{}{}
		}
		for _, name := range *in.AllowedTools {
			if _, ok := known[name]; !ok {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error": map[string]string{
						"code":    "unknown_tool",
						"message": "unknown tool name: " + name,
					},
				})
				return
			}
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "tx_failed", "message": "an internal error occurred"},
		})
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	s, err := updateSettings(r.Context(), tx, t.ID, in)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "update_failed", "message": "an internal error occurred"},
		})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "commit_failed", "message": "an internal error occurred"},
		})
		return
	}
	applyWriteTierReleasePolicy(s)
	writeJSON(w, http.StatusOK, s)
}

// catalogEntry mirrors the toolDescriptor wire shape but adds the
// `write_tier` + `required_scopes` fields the dashboard renders in
// the allowlist picker.
type catalogEntry struct {
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	InputSchema    json.RawMessage `json:"input_schema"`
	RequiredScopes []string        `json:"required_scopes"`
	WriteTier      bool            `json:"write_tier"`
	LLMOutputSafe  bool            `json:"llm_output_safe"`
}

// GetCatalog enumerates every built-in tool — independent of the
// caller's scope. Used by the desktop allowlist picker so the
// operator sees the full registry even when their key would be
// scope-filtered at runtime.
func (d *Deps) GetCatalog(w http.ResponseWriter, r *http.Request) {
	tools := d.allTools()
	out := make([]catalogEntry, 0, len(tools))
	for _, t := range tools {
		out = append(out, catalogEntry{
			Name:           t.Name,
			Description:    t.Description,
			InputSchema:    t.InputSchema,
			RequiredScopes: scopeListFor(t.RequiredScopes),
			WriteTier:      t.WriteTier,
			LLMOutputSafe:  t.LLMOutputSafe,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tools":                   out,
		"write_tier_available":    NativeWriteTierReleased,
		"write_tier_release_hold": NativeWriteTierReleaseHoldCode,
	})
}

func applyWriteTierReleasePolicy(s *Settings) {
	if s == nil {
		return
	}
	s.WriteTierAvailable = NativeWriteTierReleased
	if !NativeWriteTierReleased {
		// A stale pre-hold database row must never be represented to clients as
		// executable policy. PATCH false remains available to clean the row.
		s.WriteEnabled = false
		s.WriteTierReleaseHold = NativeWriteTierReleaseHoldCode
	}
}

// ListCalls returns the most recent mcp_server_call_log rows.
func (d *Deps) ListCalls(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "tx_failed", "message": "an internal error occurred"},
		})
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := listCallLog(r.Context(), tx, t.ID, limit)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusOK, map[string]any{"calls": []CallLogEntry{}})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "query_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"calls": rows})
}

var _ = chi.URLParam // retained for future per-tool routes
