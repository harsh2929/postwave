// SPDX-License-Identifier: AGPL-3.0-only
package subscription_types

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles dependencies for handler wiring.
//
// Logger is optional — when nil httperror.WriteInternal still emits the
// user-facing 500 envelope but suppresses the structured log line. Wire
// one in main.go so DB / RLS failures land in the operator log.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// jsonMaxBodyBytes — small cap, payloads are tiny enum-like records.
const jsonMaxBodyBytes int64 = 64 << 10 // 64 KiB

// ---------- subscription_types CRUD ----------

// List GET /api/v1/subscription-types?channel=email|sms|push|all
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	ch := Channel(strings.TrimSpace(r.URL.Query().Get("channel")))
	if ch != "" && !ValidChannels[ch] {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_channel", "channel must be one of email|sms|push|all"))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID, ch)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Create POST /api/v1/subscription-types
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, jsonMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name required"))
		return
	}
	out, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrNameConflict) {
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// Update PATCH /api/v1/subscription-types/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, jsonMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrNameConflict):
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete DELETE /api/v1/subscription-types/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrCannotDeleteDefault):
			httperror.Write(w, http.StatusConflict, "default_required", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- per-subscriber opt-out ----------

// ListForSubscriber GET /api/v1/subscribers/{id}/subscription-types
func (d *Deps) ListForSubscriber(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	subID := chi.URLParam(r, "id")
	if strings.TrimSpace(subID) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_subscriber_id", ""))
		return
	}
	out, err := d.Repo.ListForSubscriber(r.Context(), t.ID, subID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// OptOut POST /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out
func (d *Deps) OptOut(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	subID := chi.URLParam(r, "id")
	typeID := chi.URLParam(r, "type_id")
	if strings.TrimSpace(subID) == "" || strings.TrimSpace(typeID) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "subscriber id + type id required"))
		return
	}
	var in OptOutInput
	// Body is optional — POST with no body opts out on the type's default channel via api source.
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSON(w, r, jsonMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	out, err := d.Repo.OptOut(r.Context(), t.ID, subID, typeID, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// OptIn DELETE /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out
func (d *Deps) OptIn(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	subID := chi.URLParam(r, "id")
	typeID := chi.URLParam(r, "type_id")
	if strings.TrimSpace(subID) == "" || strings.TrimSpace(typeID) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "subscriber id + type id required"))
		return
	}
	ch := Channel(strings.TrimSpace(r.URL.Query().Get("channel")))
	if ch != "" && !ValidChannels[ch] {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_channel", "channel must be one of email|sms|push|all"))
		return
	}
	if err := d.Repo.OptIn(r.Context(), t.ID, subID, typeID, ch); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- helpers ----------

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
