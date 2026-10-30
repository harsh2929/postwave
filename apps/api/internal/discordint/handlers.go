package discordint

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

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

const integrationJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

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
		writeMutationError(w, d, r, err, t.ID)
		return
	}
	if len(in.Events) == 0 {
		writeMutationError(w, d, r, ErrEventsRequired, t.ID)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if d.Repo.Cipher == nil {
		writeMutationError(w, d, r, ErrCipherUnconfigured, t.ID)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		writeMutationError(w, d, r, err, t.ID)
		return
	}
	writeJSON(w, http.StatusCreated, integ)
}

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
			writeMutationError(w, d, r, err, t.ID)
			return
		}
	}
	if in.Events != nil && len(*in.Events) == 0 {
		writeMutationError(w, d, r, ErrEventsRequired, t.ID)
		return
	}
	if d == nil || d.Repo == nil {
		writeRepoUnavailable(w)
		return
	}
	if in.URL != nil && d.Repo.Cipher == nil {
		writeMutationError(w, d, r, ErrCipherUnconfigured, t.ID)
		return
	}
	if d.Repo.Pool == nil {
		writeRepoUnavailable(w)
		return
	}
	integ, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discord integration not found")
			return
		}
		writeMutationError(w, d, r, err, t.ID)
		return
	}
	writeJSON(w, http.StatusOK, integ)
}

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
			httperror.Write(w, http.StatusNotFound, "not_found", "discord integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Test POST /api/v1/integrations/discord/{id}/test — delivers a synthetic test
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
	handler := &DiscordHandler{Repo: d.Repo}
	if err := handler.SendTest(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discord integration not found")
			return
		}
		// The delivery failure is recorded on the integration's delivery log;
		// the response carries a fixed public text rather than provider error
		// detail.
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "the Discord integration could not be reached"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Deliveries GET /api/v1/integrations/discord/{id}/deliveries — recent delivery
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

func repoUnavailable(d *Deps) bool {
	return d == nil || d.Repo == nil || d.Repo.Pool == nil
}

func writeRepoUnavailable(w http.ResponseWriter) {
	httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "integration repository is not configured")
}

// writeMutationError maps known typed sentinel errors from the discordint
// package to operator-authored, non-sensitive client messages, and routes
// every other error through WriteInternal — Repo.Create / Repo.Update can
// return raw pgx/db error text, encryption-layer messages, or scan errors
// that are unsafe to echo verbatim to API consumers.
func writeMutationError(w http.ResponseWriter, d *Deps, r *http.Request, err error, tenantID string) {
	switch {
	case errors.Is(err, ErrInvalidURL):
		httperror.Write(w, http.StatusBadRequest, "invalid_url",
			"url must be a Discord webhook URL (https://discord.com/api/webhooks/<channel_id>/<token>)")
	case errors.Is(err, ErrEventsRequired):
		httperror.Write(w, http.StatusBadRequest, "no_events",
			"at least one event type required")
	case errors.Is(err, ErrCipherUnconfigured):
		httperror.Write(w, http.StatusServiceUnavailable,
			"kek_unconfigured",
			"this Moosewave deployment has no KEK configured; Discord integrations require POSTWAVE_SENDING_KEK to be set")
	default:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
