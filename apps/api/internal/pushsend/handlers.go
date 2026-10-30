// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pushtoken"
)

var validDevicePlatforms = map[string]bool{"ios": true, "android": true}

// Deps wires the device-registration handler. Store is an interface (not a
// concrete *db.Pool) so tests can substitute a fake without a database; the
// composition root constructs it as &pushsend.Repo{Pool: pool}.
type Deps struct {
	Store  DeviceUpserter
	Logger *slog.Logger
}

// MountRoutes registers POST /api/v1/push/devices. Registration requires
// write:subscribers — it attaches a push endpoint to an existing subscriber,
// the same trust boundary as editing subscriber contact info.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/push/devices", d.RegisterDevice)
}

type registerDeviceInput struct {
	SubscriberID string `json:"subscriber_id"`
	Platform     string `json:"platform"`
	Token        string `json:"token"`
	AppID        string `json:"app_id"`
	Enabled      *bool  `json:"enabled"`
}

// RegisterDevice upserts a push device token for a subscriber
// (POST /api/v1/push/devices). Re-posting the same token is idempotent
// (ON CONFLICT (tenant_id, token) in migration 1745) — a mobile app can call
// this on every launch to refresh last_seen_at and re-enable a token after a
// push-permission re-grant.
func (d *Deps) RegisterDevice(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "not_configured", "push device registration is not configured")
		return
	}

	var in registerDeviceInput
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_body", "request body must be valid JSON")
		return
	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.Platform = strings.TrimSpace(in.Platform)
	in.AppID = strings.TrimSpace(in.AppID)

	if in.SubscriberID == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "subscriber_id is required")
		return
	}
	if !validDevicePlatforms[in.Platform] {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "platform must be one of ios, android")
		return
	}
	if err := pushtoken.ValidateExact(in.Token); err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	row, err := d.Store.UpsertDevice(r.Context(), tenant.ID, UpsertDeviceInput{
		SubscriberID: in.SubscriberID,
		Platform:     in.Platform,
		Token:        in.Token,
		AppID:        in.AppID,
		Enabled:      enabled,
	})
	if err != nil {
		if errors.Is(err, ErrSubscriberNotFound) {
			httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "subscriber_id does not reference an existing subscriber")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
