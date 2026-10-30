// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers_http.go — admin endpoints for previewing transforms.
//
//	POST /api/v1/cdp/transforms/preview
//	GET  /api/v1/cdp/transforms/ops
//
// Preview is the safe-by-default endpoint: callers send a property
// map + an op list and get back the would-be result without any
// persistence. The actual persistence path is owned by bulk_import
// and the dedicated CDP runner, which both call Apply() directly.

package cdp_transforms

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxPreviewBytes = 1 << 20

// MountRoutes mounts the preview + discovery routes.
func MountRoutes(r chi.Router) {
	r.Post("/api/v1/cdp/transforms/preview", previewHandler)
	r.Get("/api/v1/cdp/transforms/ops", opsHandler)
}

type previewRequest struct {
	Properties map[string]any `json:"properties"`
	Ops        []Op           `json:"ops"`
}

func previewHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant"},
		})
		return
	}
	var req previewRequest
	if err := httpbody.DecodeJSON(w, r, maxPreviewBytes, &req); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	out := Apply(req.Properties, req.Ops)
	writeJSON(w, http.StatusOK, out)
}

func opsHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant"},
		})
		return
	}
	ops := Registered()
	sort.Strings(ops)
	writeJSON(w, http.StatusOK, map[string]any{"ops": ops})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
