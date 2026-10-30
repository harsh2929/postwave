// SPDX-License-Identifier: AGPL-3.0-only
package mandate

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The surface a PERSON uses to grant, review and withdraw agent authority.
//
// Session-only, deliberately. An API key minting mandates would let an agent
// grant itself authority — and a mandate an agent can issue to itself is not a
// bound, it is a formality. The property that makes this governance is that a
// mandate always traces to a person.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

func (d *Deps) MountRoutes(r chi.Router) {
	r.Post("/api/v1/agent-mandates", d.Create)
	r.Get("/api/v1/agent-mandates", d.List)
	r.Delete("/api/v1/agent-mandates/{id}", d.Revoke)
}

type createRequest struct {
	Purpose   string   `json:"purpose"`
	Actions   []string `json:"actions"`
	Resources []string `json:"resources"`
	Uses      int      `json:"uses"`
	TTLSecs   int      `json:"ttl_seconds"`
}

type createResponse struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	Uses      int       `json:"uses"`
	// Notice states plainly that this is the only time the token is shown.
	// Without it somebody closes the dialog and has to mint a second mandate,
	// leaving the first live until it expires.
	Notice string `json:"notice"`
}

// Create POST /api/v1/agent-mandates
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	var in createRequest
	// httpbody so an over-size body is answered as one. The bare decoder
	// reported every failure as `bad_json`, which tells a caller to go looking
	// for a syntax error in a body that had none.
	//
	// The two leniencies are deliberate and preserve what this endpoint already
	// accepted. `DecodeJSON` is strict on both axes — it requires a JSON
	// Content-Type and rejects unknown fields — and the decoder being replaced
	// did neither. Tightening them here would be a silent contract change for
	// every existing client, arriving as a 415 or a 400 on a request that
	// worked yesterday, which is a bigger break than the diagnosis bug being
	// fixed. Whether this endpoint SHOULD be strict is a separate decision.
	if err := httpbody.DecodeJSONWith(w, r, 16<<10, &in, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      true,
	}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	minted, err := d.Repo.Mint(r.Context(), tenantID, userID, Grant{
		Purpose:   in.Purpose,
		Actions:   in.Actions,
		Resources: in.Resources,
		Uses:      in.Uses,
		TTL:       time.Duration(in.TTLSecs) * time.Second,
	})
	if errors.Is(err, ErrInvalidGrant) {
		// Precise here, unlike a denial: the caller is a person configuring a
		// grant, and "not usable" with no reason is a form they cannot fix.
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_grant",
			"a mandate needs a purpose, at least one action, at least one resource, "+
				"and a use count between 1 and 10000")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, createResponse{
		ID: minted.ID, Token: minted.Token,
		ExpiresAt: minted.ExpiresAt, Uses: minted.Uses,
		Notice: "This token is shown once. Give it to the agent now; it cannot be retrieved later.",
	})
}

// List GET /api/v1/agent-mandates
//
// The question an operator asks when an agent does something unexpected: what
// is it currently allowed to do. Revoked and expired mandates are included —
// "what WAS it allowed to do an hour ago" is the same question after the fact,
// and a list that hides them cannot answer it.
//
// The token is never returned. It exists only in the agent's memory and as a
// hash here, and a list endpoint that could hand it back would make every
// reader of this page able to act as the agent.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenantID, _, ok := d.actor(w, r)
	if !ok {
		return
	}
	items, err := d.Repo.List(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items})
}

// Revoke DELETE /api/v1/agent-mandates/{id}
func (d *Deps) Revoke(w http.ResponseWriter, r *http.Request) {
	tenantID, _, ok := d.actor(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "mandate id required")
		return
	}
	if err := d.Repo.Revoke(r.Context(), tenantID, id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// 200 rather than 404 for an id that does not exist or is already revoked:
	// the caller's intent — "this must not work any more" — is satisfied either
	// way, and a 404 invites a retry loop against a mandate that is already off.
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// actor resolves the granting person, refusing anything that is not a session.
func (d *Deps) actor(w http.ResponseWriter, r *http.Request) (tenantID, userID string, ok bool) {
	if d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "unavailable", "mandates unavailable")
		return "", "", false
	}
	t, found := middleware.TenantFromContext(r.Context())
	if !found {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return "", "", false
	}
	u, hasUser := middleware.UserFromContext(r.Context())
	if !hasUser || u == nil || u.ID == "" {
		// An API key has no granting person behind it. Letting one mint would
		// let an agent grant itself authority, and a self-issued bound is not a
		// bound.
		httperror.Write(w, http.StatusForbidden, "session_required",
			"a mandate must be granted by a signed-in person")
		return "", "", false
	}
	return t.ID, u.ID, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// The create response carries the only copy of a bearer token.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
