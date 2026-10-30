package slackint

import (
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

// Deps bundles the dependencies handlers need.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

const integrationJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// List GET /api/v1/integrations/slack
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Create POST /api/v1/integrations/slack
//
// Body: {url, channel_hint?, events:[...]}. URL is encrypted before
// storage and never returned by subsequent reads.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
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
		writeMutationError(w, d, r, "create_failed", http.StatusInternalServerError, err, t.ID)
		return
	}
	if len(in.Events) == 0 {
		writeMutationError(w, d, r, "create_failed", http.StatusInternalServerError, ErrEventsRequired, t.ID)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if d.Repo.Cipher == nil {
		writeMutationError(w, d, r, "create_failed", http.StatusInternalServerError, ErrCipherUnconfigured, t.ID)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		writeMutationError(w, d, r, "create_failed", http.StatusInternalServerError, err, t.ID)
		return
	}
	writeJSON(w, http.StatusCreated, integ)
}

// Update PATCH /api/v1/integrations/slack/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
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
			writeMutationError(w, d, r, "update_failed", http.StatusBadRequest, err, t.ID)
			return
		}
	}
	if in.Events != nil && len(*in.Events) == 0 {
		writeMutationError(w, d, r, "update_failed", http.StatusBadRequest, ErrEventsRequired, t.ID)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if in.URL != nil && d.Repo.Cipher == nil {
		writeMutationError(w, d, r, "update_failed", http.StatusBadRequest, ErrCipherUnconfigured, t.ID)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "slack integration not found")
			return
		}
		writeMutationError(w, d, r, "update_failed", http.StatusBadRequest, err, t.ID)
		return
	}
	writeJSON(w, http.StatusOK, integ)
}

// Delete DELETE /api/v1/integrations/slack/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "slack integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Test POST /api/v1/integrations/slack/{id}/test — delivers a synthetic test
// notification to the integration's webhook (INTG-033).
func (d *Deps) Test(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	handler := &SlackHandler{Repo: d.Repo}
	if err := handler.SendTest(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "slack integration not found")
			return
		}
		// A delivery failure is an operator-facing result, not a server fault:
		// report it as 502 with a fixed public text. The reason is recorded on
		// the integration's delivery log, never echoed from the provider error.
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "the Slack integration could not be reached"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Deliveries GET /api/v1/integrations/slack/{id}/deliveries — recent delivery
// history for one integration (INTG-033 Slice B).
func (d *Deps) Deliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	items, err := chatdelivery.List(r.Context(), d.Repo.Pool, t.ID, chi.URLParam(r, "id"), 50)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetWorkspaceConnection GET /api/v1/integrations/slack-workspace
func (d *Deps) GetWorkspaceConnection(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	out, err := d.Repo.GetWorkspaceConnectionStatus(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DisconnectWorkspaceConnection DELETE /api/v1/integrations/slack-workspace
func (d *Deps) DisconnectWorkspaceConnection(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if repoUnavailable(d) {
		writeRepoUnavailable(w)
		return
	}
	deleted, err := d.Repo.DisconnectWorkspaceConnection(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func repoUnavailable(d *Deps) bool {
	return d == nil || d.Repo == nil || d.Repo.Pool == nil
}

func writeRepoUnavailable(w http.ResponseWriter) {
	httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "integration repository is not configured")
}

func writeMutationError(w http.ResponseWriter, d *Deps, r *http.Request, fallbackCode string, fallbackStatus int, err error, tenantID string) {
	switch {
	case errors.Is(err, ErrInvalidURL):
		httperror.Write(w, http.StatusBadRequest, "invalid_url",
			"url must be a Slack incoming-webhook URL (https://hooks.slack.com/services/T.../B.../xxx)")
	case errors.Is(err, ErrEventsRequired):
		httperror.Write(w, http.StatusBadRequest, "no_events",
			"at least one event type required")
	case errors.Is(err, ErrCipherUnconfigured):
		httperror.Write(w, http.StatusServiceUnavailable,
			"kek_unconfigured",
			"this Moosewave deployment has no KEK configured; Slack integrations require POSTWAVE_SENDING_KEK to be set")
	default:
		if fallbackStatus >= 500 {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
		httperror.Write(w, fallbackStatus, fallbackCode, httperror.MessageForStatus(fallbackStatus))
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
