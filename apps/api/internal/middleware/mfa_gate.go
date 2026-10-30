// SPDX-License-Identifier: AGPL-3.0-only
//
// mfa_gate.go — enforces tenant_security_settings.require_2fa_* at
// session-access time. Closes the audit finding C1 from the auth
// boundary review: the MFA policy was stored, the TOTP enroll +
// challenge endpoints existed, but nothing forced a session through
// the challenge before allowing access to protected routes.
//
// Enforcement model:
//
//   - Reads tenant_security_settings on every request (single-row
//     PK lookup; <1ms). No cache — admin policy changes take
//     immediate effect, which is what the operator expects.
//
//   - If the policy demands MFA for this user (require_2fa_for_all,
//     OR require_2fa_for_admins + user.role in owner/admin) AND
//     the session has not satisfied MFA, the request is rejected
//     with 403 + `{"error":{"code":"mfa_required",...}}`. The
//     dashboard intercepts this and redirects to the TOTP
//     challenge page.
//
//   - A small exempt set lets the user actually SATISFY MFA: the
//     real TOTP enroll / verify / challenge endpoints, logout, and
//     both /me variants (so the dashboard can route the user without
//     "MFA required" banner without bouncing). Adjust mfaExemptPath
//     if you add new "needed to complete MFA" routes.
//
//   - API-key requests bypass this gate entirely. API keys are
//     long-lived bearer credentials issued out-of-band; per-request
//     TOTP challenge doesn't apply (the operator's protection is
//     scoped key rotation, not MFA step-up).
//
//   - When tenant_security_settings has no row (lazy default), the
//     policy is "no requirement" — same posture as Update with the
//     defaults.
//
// The middleware is wired AFTER TenantMiddleware (needs the user)
// and BEFORE the per-route handlers.

package middleware

import (
	"encoding/json"

	"context"
	"errors"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RequireMFAIfPolicy returns a middleware that enforces
// tenant_security_settings.require_2fa_* against
// User.MFASatisfied. See package doc for the threat model.
func RequireMFAIfPolicy(pool *db.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if mfaExemptPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			// Only a credential that the API-key middleware actually verified may
			// bypass session MFA. Authorization is attacker-controlled input; using
			// its raw shape here let a cookie-authenticated pre-MFA session add
			// "Bearer x" and skip the gate.
			if IsAPIKeyAuth(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}
			tenant, ok := TenantFromContext(r.Context())
			if !ok {
				writeMFAError(w, http.StatusUnauthorized, "missing_tenant", "authenticated tenant context required")
				return
			}
			user, hasUser := UserFromContext(r.Context())
			if !hasUser {
				writeMFAError(w, http.StatusUnauthorized, "missing_user", "authenticated user context required")
				return
			}
			needsMFA, found, err := mfaRequiredForUser(r.Context(), pool, tenant.ID, user.Role)
			if err != nil {
				// Policy-store failures are security failures, not an implicit "MFA
				// disabled" policy. Returning 503 lets clients retry without granting
				// access under an unknown policy state.
				writeMFAError(w, http.StatusServiceUnavailable, "mfa_policy_unavailable", "MFA policy could not be verified")
				return
			}
			if !found {
				// A missing row is the documented lazy default: MFA is not required.
				next.ServeHTTP(w, r)
				return
			}
			if !needsMFA {
				next.ServeHTTP(w, r)
				return
			}
			hasFactor, err := hasConfirmedTOTPForUser(r.Context(), pool, tenant.ID, user.ID)
			if err != nil {
				writeMFAError(w, http.StatusServiceUnavailable, "mfa_policy_unavailable", "MFA enrollment could not be verified")
				return
			}
			if !hasFactor {
				writeMFAPolicyGateDenial(w, "tenant policy requires two-factor enrollment before retrying")
				return
			}
			if user.MFASatisfied {
				next.ServeHTTP(w, r)
				return
			}
			writeMFAPolicyGateDenial(w, "tenant policy requires two-factor authentication; submit a TOTP challenge before retrying")
		})
	}
}

// writeMFAError is the remaining hand-rolled writer, for the 401 and 503 paths
// that are not entitlement denials (no tenant, no user, policy unreadable).
//
// Encoded with json.Marshal rather than string concatenation. The previous form
// interpolated `message` straight into a JSON literal, which was safe only for
// as long as every caller passed a quote-free constant — one message carrying a
// `"` would have produced a malformed body that a client parses as a transport
// failure rather than the refusal it is.
func writeMFAError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	body, err := json.Marshal(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
	if err != nil {
		// Unreachable for these inputs; a bare code beats an empty body.
		body = []byte(`{"error":{"code":"` + code + `"}}`)
	}
	_, _ = w.Write(body)
}

// writeMFAPolicyGateDenial refuses a request that has not satisfied the
// workspace's two-factor policy.
//
// ReasonPolicy: a step the caller takes, not a role they lack. The message is a
// parameter because the two sites mean different things — "you have not enrolled
// a factor" and "you have one but have not used it on this session" — and the
// wording is the entire instruction.
func writeMFAPolicyGateDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "mfa_policy",
		Reason:  entitlement.ReasonPolicy,
		Code:    "mfa_required",
		Message: message,
	})
}

// mfaExemptPath is the small set of routes that may be hit by a
// session that has NOT yet completed MFA — needed to actually
// complete the challenge or read minimal identity for the UI.
func mfaExemptPath(path string) bool {
	switch path {
	case "/api/v1/auth/logout",
		"/api/v1/me",
		"/api/v1/auth/me",
		// The handler allows read-only inspect/deny here, then re-applies the
		// same policy before approve. Without this narrow exemption an
		// unsatisfied user cannot even learn what is requesting access or see
		// the `requires_mfa` recovery contract.
		"/api/v1/auth/cli/device/approve",
		"/api/v1/auth/totp/enroll",
		"/api/v1/auth/totp/verify",
		"/api/v1/auth/totp/challenge":
		return true
	}
	return false
}

// MFARequiredForUser reports whether the tenant policy requires MFA for the
// supplied durable role. The second result reports whether the decision is
// authoritative: a missing row is the known default (required=false, ok=true),
// while a policy-store failure is unknown (required=false, ok=false). It is
// exported so /api/v1/auth/me can describe the same decision the middleware
// enforces without duplicating SQL or role rules.
func MFARequiredForUser(ctx context.Context, pool *db.Pool, tenantID, role string) (bool, bool) {
	required, found, err := mfaRequiredForUser(ctx, pool, tenantID, role)
	if err != nil {
		return false, false
	}
	if !found {
		return false, true
	}
	return required, true
}

func mfaRequiredForUser(ctx context.Context, pool *db.Pool, tenantID, role string) (bool, bool, error) {
	requireAll, requireAdmins, found, err := lookupMFAPolicy(ctx, pool, tenantID)
	if err != nil || !found {
		return false, found, err
	}
	return mfaRequiredByPolicy(requireAll, requireAdmins, role), true, nil
}

func mfaRequiredByPolicy(requireAll, requireAdmins bool, role string) bool {
	normalizedRole := strings.ToLower(strings.TrimSpace(role))
	adminish := normalizedRole == "owner" || normalizedRole == "admin"
	return requireAll || (requireAdmins && adminish)
}

func hasConfirmedTOTPForUser(ctx context.Context, pool *db.Pool, tenantID, userID string) (bool, error) {
	if pool == nil {
		return false, errors.New("MFA enrollment store is not configured")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var confirmed bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM auth_totp_secrets
     WHERE tenant_id = $1::uuid
       AND user_id = $2::uuid
       AND last_used_at IS NOT NULL
)`, tenantID, userID).Scan(&confirmed); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return confirmed, nil
}

// lookupMFAPolicy reads tenant_security_settings for the tenant.
// Returns (requireAll, requireAdmins, true) on hit; (false, false,
// false) when no row exists. Runs inside a tenant-scoped tx so the
// RLS policy on tenant_security_settings is honoured.
func lookupMFAPolicy(ctx context.Context, pool *db.Pool, tenantID string) (bool, bool, bool, error) {
	if pool == nil {
		return false, false, false, errors.New("MFA policy store is not configured")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, false, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var requireAll, requireAdmins bool
	err = tx.QueryRow(ctx,
		`SELECT require_2fa_for_all, require_2fa_for_admins
           FROM tenant_security_settings
          WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&requireAll, &requireAdmins)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, false, false, nil
		}
		return false, false, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, false, false, err
	}
	return requireAll, requireAdmins, true, nil
}
