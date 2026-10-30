// SPDX-License-Identifier: AGPL-3.0-only
//
// sessions_handler.go — operator-facing session management for the
// "log out everywhere" / "show me all my active sessions" UX.
//
// Endpoints (under the protected tenant-scoped router; require a
// resolved session/user via the existing TenantMiddleware):
//
//   GET    /api/v1/auth/sessions             list the current user's
//                                              active sessions
//   DELETE /api/v1/auth/sessions/{id}        revoke one session
//   POST   /api/v1/auth/sessions/logout-all  revoke EVERY other
//                                              session for this user
//                                              (the current request's
//                                              session stays alive)
//
// SOC 2 maps this to access-control evidence: every operator can
// see who's logged in as them + cut access at any time. The
// audit_log captures each revoke for the security team.

package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// SessionInfo is the wire shape — strips the verifier_hash + only
// returns rows the operator should see (their own, active).
type SessionInfo struct {
	ID         string    `json:"id"`
	IssuedAt   time.Time `json:"issued_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	IP         string    `json:"ip,omitempty"`
	UserAgent  string    `json:"user_agent,omitempty"`
	AuthMethod string    `json:"auth_method"`
	Current    bool      `json:"current"`
	// DeviceIdentity is the server-normalised view of UserAgent (AUTH#53).
	// Inlined so the wire shape stays flat and purely additive:
	// device_label / device_type / device_os / device_client sit alongside
	// the existing fields, and user_agent is still returned for anyone who
	// wants the raw string.
	//
	// This exists so the three clients stop each hand-rolling a UA parser.
	// Derived at read time rather than stored, so it applies to every
	// session row that already exists and improves for all of them at once
	// when the table in device_label.go learns a new browser.
	DeviceIdentity
}

// MountSessionRoutes registers the three endpoints. Caller wires
// these inside the protected tenant group so middleware.UserFromContext
// is populated.
func (d *Deps) MountSessionRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/auth/sessions", d.ListSessions)
	r.Delete("/api/v1/auth/sessions/{id}", d.RevokeOneSession)
	r.Post("/api/v1/auth/sessions/logout-all", d.LogoutAllOthers)
}

// ListSessions GET /api/v1/auth/sessions.
func (d *Deps) ListSessions(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeAuthErr(w, http.StatusUnauthorized, "no_user",
			"endpoint requires a session-resolved user")
		return
	}
	currentSessionID, _ := currentSessionID(r)
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeAuthErr(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	sessions, next, err := d.Repo.ListUserSessions(r.Context(), u.ID, limit, cursor)
	if err != nil {
		writeAuthErr(w, http.StatusInternalServerError, "list_failed", "an internal error occurred")
		return
	}
	out := make([]SessionInfo, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, SessionInfo{
			ID:             s.ID,
			IssuedAt:       s.IssuedAt,
			LastSeenAt:     s.LastSeenAt,
			ExpiresAt:      s.ExpiresAt,
			IP:             s.IP,
			UserAgent:      s.UserAgent,
			AuthMethod:     s.AuthMethod,
			Current:        s.ID == currentSessionID,
			DeviceIdentity: IdentifyDevice(s.UserAgent),
		})
	}
	// Additive over the prior {"sessions":[...]} shape: nextCursor is
	// added only when more pages remain (omitted on the last page).
	body := map[string]any{"sessions": out}
	if next != "" {
		body["nextCursor"] = next
	}
	writeAuthJSON(w, http.StatusOK, body)
}

// RevokeOneSession DELETE /api/v1/auth/sessions/{id}.
// Only revokes sessions belonging to the calling user. Returns 404
// when the id either doesn't exist or belongs to someone else (we
// don't distinguish — leaks less info to a session-id-fishing
// attack).
func (d *Deps) RevokeOneSession(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeAuthErr(w, http.StatusUnauthorized, "no_user", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeAuthErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	revoked, err := d.Repo.RevokeUserSessionByID(r.Context(), u.ID, id)
	if err != nil {
		writeAuthErr(w, http.StatusInternalServerError, "revoke_failed", "an internal error occurred")
		return
	}
	if !revoked {
		writeAuthErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// LogoutAllOthers POST /api/v1/auth/sessions/logout-all.
// Revokes every session for the calling user EXCEPT the current
// one. Returns the count of revoked sessions so the UI can show
// "logged out 3 other devices."
func (d *Deps) LogoutAllOthers(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeAuthErr(w, http.StatusUnauthorized, "no_user", "")
		return
	}
	currentSessionID, _ := currentSessionID(r)
	count, err := d.Repo.RevokeUserSessionsExcept(r.Context(), u.ID, currentSessionID)
	if err != nil {
		writeAuthErr(w, http.StatusInternalServerError, "revoke_failed", "an internal error occurred")
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{"revoked_count": count})
}

// currentSessionID parses the session cookie to recover the current
// session's id so ListSessions can flag it + LogoutAllOthers can
// exclude it.
func currentSessionID(r *http.Request) (string, error) {
	tok, err := ParseSessionCookie(r)
	if err != nil {
		return "", err
	}
	return tok.ID, nil
}

// --- helpers ---

func writeAuthJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAuthErr(w http.ResponseWriter, status int, code, msg string) {
	writeAuthJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep context referenced for future timeout-aware ops.
var _ context.Context = nil
