// SPDX-License-Identifier: AGPL-3.0-only
//
// Package webpush is the server side of browser Web Push (RFC 8030/8291 +
// VAPID 8292). The web client already had a service-worker push handler but no
// server to register subscriptions or deliver to them. This package stores
// per-browser PushSubscriptions, exposes the VAPID public key the client needs
// to subscribe, and (sender.go) encrypts + delivers notifications, pruning dead
// endpoints.
//
// VAPID keys come from the environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT). When they're unset the feature is disabled and the endpoints
// say so, so the client never tries to subscribe. Generate a keypair with
// webpush.GenerateVAPIDKeys().
package webpush

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps carries the pool + VAPID config.
type Deps struct {
	Pool       *db.Pool
	PublicKey  string // VAPID public key (base64url) — safe to expose
	PrivateKey string // VAPID private key (base64url) — secret
	Subject    string // VAPID "sub": a mailto: or https: contact URL
	Logger     *slog.Logger

	// httpClient overrides the SSRF-guarded delivery client. nil (the
	// default) uses safePushClient; tests set it to reach a loopback mock.
	httpClient *http.Client
}

func (d *Deps) client() *http.Client {
	if d.httpClient != nil {
		return d.httpClient
	}
	return safePushClient
}

// Enabled reports whether Web Push is configured (pool + VAPID keypair present).
func (d *Deps) Enabled() bool {
	return d != nil && d.Pool != nil && d.PublicKey != "" && d.PrivateKey != ""
}

func (d *Deps) subject() string {
	if d.Subject != "" {
		return d.Subject
	}
	return "mailto:noreply@moosewave.com"
}

func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/notifications/web-push/vapid-public-key", d.VAPIDPublicKey)
	r.Post("/api/v1/notifications/web-push/subscribe", d.Subscribe)
	r.Post("/api/v1/notifications/web-push/unsubscribe", d.Unsubscribe)
	r.Post("/api/v1/notifications/web-push/test", d.Test)
}

// Test sends the caller a notification to their own subscriptions, so they can
// confirm the round-trip (browser subscribed → server delivers → SW renders).
func (d *Deps) Test(w http.ResponseWriter, r *http.Request) {
	if !d.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, errBody("push_disabled", "web push is not configured"))
		return
	}
	tenantID, userID, ok := tenantUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errBody("no_session", "sign in first"))
		return
	}
	sent, err := d.SendToUser(r.Context(), tenantID, userID, Notification{
		Title: "Moosewave test notification",
		Body:  "Browser notifications are working 🎉",
		URL:   "/app",
		Tag:   "webpush-test",
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("send_failed", "an internal error occurred"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivered": sent})
}

// VAPIDPublicKey returns the key the service worker needs to subscribe, plus an
// `enabled` flag so the client can skip subscribing when push is unconfigured.
func (d *Deps) VAPIDPublicKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":    d.Enabled(),
		"public_key": d.PublicKey,
	})
}

type subscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func (d *Deps) Subscribe(w http.ResponseWriter, r *http.Request) {
	if !d.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, errBody("push_disabled", "web push is not configured"))
		return
	}
	tenantID, userID, ok := tenantUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errBody("no_session", "sign in first"))
		return
	}
	var req subscribeRequest
	if err := httpbody.DecodeJSON(w, r, 16<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if strings.TrimSpace(req.Endpoint) == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errBody("incomplete", "endpoint + keys.p256dh + keys.auth required"))
		return
	}
	// SSRF: only let known push-service hosts be registered, so the server can
	// never be coaxed into POSTing to an internal endpoint (defense in depth
	// with the connect-time IP guard in safehttp.go).
	if !allowedPushHost(req.Endpoint) {
		writeJSON(w, http.StatusUnprocessableEntity, errBody("bad_endpoint", "endpoint is not a recognized push service"))
		return
	}
	if err := d.upsertSubscription(r.Context(), tenantID, userID, req.Endpoint, req.Keys.P256dh, req.Keys.Auth); err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("store_failed", "an internal error occurred"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscribed": true})
}

type unsubscribeRequest struct {
	Endpoint string `json:"endpoint"`
}

func (d *Deps) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := tenantUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errBody("no_session", "sign in first"))
		return
	}
	var req unsubscribeRequest
	if err := httpbody.DecodeJSON(w, r, 16<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if strings.TrimSpace(req.Endpoint) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errBody("no_endpoint", "endpoint required"))
		return
	}
	// Scoped to the caller's own subscription — a user can't remove another
	// user's browser registration.
	if err := d.deleteSubscription(r.Context(), tenantID, userID, req.Endpoint); err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("delete_failed", "an internal error occurred"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"unsubscribed": true})
}

func tenantUser(r *http.Request) (tenantID, userID string, ok bool) {
	t, tok := middleware.TenantFromContext(r.Context())
	if !tok {
		return "", "", false
	}
	u, uok := middleware.UserFromContext(r.Context())
	if !uok || u == nil {
		return "", "", false
	}
	return t.ID, u.ID, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errBody(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}
