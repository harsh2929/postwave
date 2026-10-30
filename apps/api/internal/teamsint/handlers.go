package teamsint

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/chatdelivery"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

const integrationJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, integrationJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.URL = strings.TrimSpace(in.URL)
	in.ChannelHint = strings.TrimSpace(in.ChannelHint)
	if err := validateURL(in.URL); err != nil {
		d.writeMutationError(w, r.Context(), "create_failed", http.StatusInternalServerError, err)
		return
	}
	if len(in.Events) == 0 {
		d.writeMutationError(w, r.Context(), "create_failed", http.StatusInternalServerError, ErrEventsRequired)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if d.Repo.Cipher == nil {
		d.writeMutationError(w, r.Context(), "create_failed", http.StatusInternalServerError, ErrCipherUnconfigured)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		d.writeMutationError(w, r.Context(), "create_failed", http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, integ)
}

func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, integrationJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.URL != nil {
		trimmed := strings.TrimSpace(*in.URL)
		in.URL = &trimmed
		if err := validateURL(trimmed); err != nil {
			d.writeMutationError(w, r.Context(), "update_failed", http.StatusBadRequest, err)
			return
		}
	}
	if in.Events != nil && len(*in.Events) == 0 {
		d.writeMutationError(w, r.Context(), "update_failed", http.StatusBadRequest, ErrEventsRequired)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if in.URL != nil && d.Repo.Cipher == nil {
		d.writeMutationError(w, r.Context(), "update_failed", http.StatusBadRequest, ErrCipherUnconfigured)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		d.writeMutationError(w, r.Context(), "update_failed", http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, integ)
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Test POST /api/v1/integrations/teams/{id}/test — delivers a synthetic test
// notification to the integration's webhook (INTG-033).
func (d *Deps) Test(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	handler := &TeamsHandler{Repo: d.Repo}
	if err := handler.SendTest(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "the Teams integration could not be reached"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Deliveries GET /api/v1/integrations/teams/{id}/deliveries — recent delivery
// history for one integration (INTG-033 Slice B).
func (d *Deps) Deliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	items, err := chatdelivery.List(r.Context(), d.Repo.Pool, t.ID, chi.URLParam(r, "id"), 50)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func repoUnavailable(d *Deps) bool {
	return d == nil || d.Repo == nil || d.Repo.Pool == nil
}

func writeRepoUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "integration repository is not configured"))
}

func (d *Deps) writeMutationError(w http.ResponseWriter, ctx context.Context, fallbackCode string, fallbackStatus int, err error) {
	switch {
	case errors.Is(err, ErrInvalidURL):
		httperror.WriteValidation(w, "invalid_url",
			"url must be a Microsoft Teams webhook URL (https://<tenant>.webhook.office.com/webhookb2/... or https://outlook.office.com/webhook/...)")
	case errors.Is(err, ErrEventsRequired):
		httperror.WriteValidation(w, "no_events",
			"at least one event type required")
	case errors.Is(err, ErrCipherUnconfigured):
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"kek_unconfigured",
			"this Moosewave deployment has no KEK configured; Teams integrations require POSTWAVE_SENDING_KEK to be set"))
	default:
		var logger *slog.Logger
		if d != nil {
			logger = d.Logger
		}
		// Unknown (non-sentinel) errors may carry internal infra details
		// (encrypt failures, DB errors, etc.) and must not be echoed to the
		// client regardless of the caller-supplied fallback status/code.
		_, _ = fallbackCode, fallbackStatus
		httperror.WriteInternal(w, logger, err, ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
