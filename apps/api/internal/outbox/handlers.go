// SPDX-License-Identifier: AGPL-3.0-only
//
// Admin handlers for DLQ inspection + replay. Mounted in main.go
// behind ScopeAdmin — these are operator surfaces, not customer
// SDK contracts.
package outbox

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// failure detail without leaking err.Error() to API callers.
	// Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// List GET /api/v1/dlq — list dead-letter rows for the tenant.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.ListDLQ(r.Context(), t.ID, 50)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Replay POST /api/v1/dlq/{id}/replay — push a failed row back into
// the worker queue. Returns 404 when the id isn't a DLQ row (already
// drained or not found).
func (d *Deps) Replay(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.ReplayDLQ(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNoEvents) {
			writeJSON(w, http.StatusNotFound, errEnv("not_dlq",
				"row not found in DLQ (already drained or not yours)"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "replayed_id": id})
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
