// SPDX-License-Identifier: AGPL-3.0-only
package safety

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// Deps wires the HTTP handler.
type Deps struct {
	Service *Service
	Logger  *slog.Logger
}

const safetyJSONMaxBodyBytes int64 = 512 << 10 // 512 KiB

// Check exposes POST /api/v1/safety/check. Tenant-scoped via the upstream
// tenant middleware; the handler itself does not need the tenant id.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	var draft DraftToCheck
	if err := httpbody.DecodeJSON(w, r, safetyJSONMaxBodyBytes, &draft); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), "invalid JSON body")
		return
	}
	v, err := d.Service.Check(r.Context(), draft)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": errCode, "message": msg},
	})
}
