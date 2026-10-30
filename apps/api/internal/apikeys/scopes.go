// SPDX-License-Identifier: AGPL-3.0-only
//
// This file extends the apikeys package with:
//
//  1. Additional, more specialised scopes (e.g. ScopeMCP) that aren't
//     part of the original CRUD enum in apikeys.go. They live here so
//     they can be added/removed without churning the long-lived scope
//     constants used by the dashboard scope picker.
//
//  2. The AuthMethod concept + the RequireAuthMethod middleware. The
//     existing RequireScope gate honours session-cookie auth as long as
//     the user has the matching role — that is the right default for
//     dashboard parity. A handful of "machine-only" endpoints (the
//     native MCP RPC, programmatic webhooks, etc.) must reject session
//     cookies outright because they are designed to be driven by a
//     credentialed agent, not a logged-in human clicking around. This
//     file provides the gate for those routes.
package apikeys

import (
	"context"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ScopeMCP authorises a key to drive the native MCP RPC endpoint
// (POST /api/v1/mcp/rpc). The endpoint already performs per-tool
// scope checks inside the JSON-RPC frame (so e.g. subscribers tools
// still need read:subscribers / write:subscribers), but admitting a
// caller to the endpoint at all is gated on ScopeMCP — that lets the
// dashboard issue narrow MCP-only keys without granting any of the
// CRUD scopes, and conversely lets ordinary CRUD keys NOT be able to
// drive an MCP client. ScopeAdmin still grants ScopeMCP as a
// wildcard (see HasScope).
const ScopeMCP Scope = "mcp"

// init wires the additional scopes from this file into the canonical
// AllScopes catalog so IsValidScope and the dashboard scope picker
// see them. Defining the constant in a separate file would otherwise
// leave the catalog stale.
//
//nolint:gochecknoinits // catalog registration only
func init() {
	AllScopes = append(AllScopes, ScopeMCP)
}

// AuthMethod identifies how a request was authenticated. It is a
// string alias so callers can declare required methods in a type-safe
// way without importing the middleware package directly.
type AuthMethod string

const (
	// AuthMethodAPIKey marks requests authenticated via a personal-access
	// token (Authorization: Bearer pw_*) OR a short-lived stream token
	// (ParseStreamToken). Both stamp middleware.WithAPIKeyAuth on the
	// request context, and both represent a credentialed non-human
	// caller — the right primitive for "machine-only" route gating.
	AuthMethodAPIKey AuthMethod = "api_key"

	// AuthMethodSession marks requests authenticated via the dashboard
	// session cookie. A session-authenticated caller has a logged-in
	// human behind it. RequireAuthMethod(AuthMethodAPIKey) rejects
	// these.
	AuthMethodSession AuthMethod = "session"
)

// AuthMethodFromContext reports the auth method that produced the
// current request context. Returns "" when the request is
// unauthenticated (e.g. the bearer-token middleware ran but the
// request carried no credentials).
//
// API-key auth wins precedence over session auth in the rare case
// both are stamped (the bearer-token middleware doesn't run when a
// session cookie is already validated, but the precedence is well-
// defined regardless).
func AuthMethodFromContext(ctx context.Context) AuthMethod {
	if middleware.IsAPIKeyAuth(ctx) {
		return AuthMethodAPIKey
	}
	if _, ok := middleware.UserFromContext(ctx); ok {
		return AuthMethodSession
	}
	return ""
}

// RequireAuthMethod enforces that the request was authenticated via
// one of the allowed methods. Requests authenticated via any other
// method (including unauthenticated requests that slipped past an
// upstream gate) get 403 insufficient_auth_method.
//
// Typical use is to lock a route to API-key auth only — i.e. reject
// dashboard session cookies — when the endpoint is designed for
// programmatic / agent callers. Pair with RequireScope to enforce the
// permission level on top of the auth method, e.g.:
//
//	r.With(RequireAuthMethod(AuthMethodAPIKey)).
//	    With(RequireScope(ScopeMCP)).
//	    Post("/api/v1/mcp/rpc", mcp.HandleRPC)
//
// The order matters only for error precedence: putting auth-method
// first ensures a session-cookie caller sees insufficient_auth_method
// rather than insufficient_scope, which is more diagnostic.
func RequireAuthMethod(allowed ...AuthMethod) func(http.Handler) http.Handler {
	allow := make(map[AuthMethod]struct{}, len(allowed))
	for _, m := range allowed {
		allow[m] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := AuthMethodFromContext(r.Context())
			if _, ok := allow[got]; !ok {
				writeAuthMethodDenial(w, "this route requires one of: "+joinAuthMethods(allowed))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func joinAuthMethods(methods []AuthMethod) string {
	out := ""
	for i, m := range methods {
		if i > 0 {
			out += ", "
		}
		out += string(m)
	}
	return out
}
