package handlers

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Handlers bundles per-request dependencies (db pool, etc.) so handlers
// don't reach for package-globals. Construct one in main.go and bind its
// methods onto the chi router.
type Handlers struct {
	Pool *db.Pool
}

// Me proves the tenant-context pipeline is working end-to-end. It echoes
// the resolved tenant slug + user email (when present) back to the caller.
//
// GET /api/v1/me
func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{
				"code":    "no_tenant",
				"message": "tenant middleware did not run",
			},
		})
		return
	}

	resp := map[string]any{
		"tenant": tenant.Slug,
		"user":   nil,
	}
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		resp["user"] = u.Email
	}
	writeJSON(w, http.StatusOK, resp)
}
