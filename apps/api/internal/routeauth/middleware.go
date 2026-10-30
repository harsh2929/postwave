// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Middleware is mounted on every tenant-authenticated route group. It denies
// an unclassified request before the handler and evaluates the generated auth
// method, session-role, and API-key-scope decision. Public/internal policies
// are left to their route-specific token/signature boundary when they happen
// to share a nested router; startup validation only requires this middleware
// for authenticated policies.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		policy, ok := defaultManifest.policyFor(r.Method, r.URL.Path)
		if !ok {
			writeUnclassifiedRouteDenial(w)
			return
		}
		if policy.Exposure == ExposureReleaseHeld {
			writeReleaseHeldRoute(w, policy.ReleaseHoldCode)
			return
		}
		if policy.Exposure != ExposureAuthenticated {
			next.ServeHTTP(w, r)
			return
		}

		authMethod := apikeys.AuthMethodFromContext(r.Context())
		if authMethod == "" {
			httperror.Write(w, http.StatusUnauthorized, "missing_principal",
				"an authenticated API key or dashboard user is required")
			return
		}
		if !allowsAuthMethod(*policy, authMethod) {
			writeAuthMethodDenial(w)
			return
		}

		if authMethod == apikeys.AuthMethodAPIKey {
			if policy.APIKeyScopeMode == ScopeModeAny && !hasAnyScope(r, policy.APIKeyScopes) {
				writeRouteScopeDenial(w, "api key does not have permission for this route")
				return
			}
			if policy.APIKeyScopeMode == ScopeModeAll && !hasAllScopes(r, policy.APIKeyScopes) {
				writeRouteScopeDenial(w, "api key does not have every permission required for this route")
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		user, present := middleware.UserFromContext(r.Context())
		if !present || !roleAllows(user.EffectiveRoleOrDurable(), policy.SessionMinimumRole) {
			writeRouteRoleDenial(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeReleaseHeldRoute(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{
		Error: "the in-app agent is release-held",
		Code:  code,
	})
}

func allowsAuthMethod(policy Policy, method apikeys.AuthMethod) bool {
	for _, allowed := range policy.AuthMethods {
		if allowed == string(method) {
			return true
		}
	}
	return false
}

func hasAnyScope(r *http.Request, names []string) bool {
	scopes := make([]apikeys.Scope, 0, len(names))
	for _, name := range names {
		scopes = append(scopes, apikeys.Scope(name))
	}
	return apikeys.HasScope(r.Context(), scopes...)
}

func hasAllScopes(r *http.Request, names []string) bool {
	scopes := make([]apikeys.Scope, 0, len(names))
	for _, name := range names {
		scopes = append(scopes, apikeys.Scope(name))
	}
	return apikeys.HasAllScopes(r.Context(), scopes...)
}

func roleAllows(actual, minimum string) bool {
	ranks := map[string]int{
		"viewer": 1,
		// "member" survives in older mobile/session fixtures. The durable
		// database vocabulary now calls this tier viewer; keep read parity
		// without granting editor mutations.
		"member": 1,
		"editor": 2,
		"admin":  3,
		"owner":  4,
	}
	actualRank, known := ranks[strings.ToLower(strings.TrimSpace(actual))]
	if !known {
		return false
	}
	minimumRank, known := ranks[strings.ToLower(strings.TrimSpace(minimum))]
	return known && actualRank >= minimumRank
}
