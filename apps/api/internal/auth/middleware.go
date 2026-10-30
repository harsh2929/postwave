// SPDX-License-Identifier: AGPL-3.0-only
//
// Session resolver — bridges auth.Repo into the tenant middleware.
// main.go wires this to middleware.TenantOptions.SessionResolver via
// a small adapter (because auth doesn't import middleware: cycle
// break).
package auth

import (
	"context"
	"errors"
	"net/http"

	"time"
)

// ResolvedSession is what the resolver returns. main.go re-shapes
// this into middleware's *Tenant / *User types.
type ResolvedSession struct {
	TenantID   string
	TenantSlug string
	TenantName string
	TenantTier string
	UserID     string
	UserEmail  string
	// UserRole is the durable, immutable role from users.role. It is the
	// authoritative role for any escalation decision and is what audit
	// attributes. NEVER mutated by the View-as-Viewer preview.
	UserRole string
	// EffectiveRole is the role the UI should gate on for THIS session. It
	// equals UserRole unless the session carries a SUB-091 role_override
	// (View-as-Viewer preview), in which case it is the (down-only) override.
	// Permission checks that protect data (write/admin gating) read this so
	// an admin previewing as viewer sees the read-only experience; the
	// durable UserRole still governs whether the override may be set at all.
	EffectiveRole string
	// SessionID is the auth_sessions.id for the resolved session. Surfaced
	// so the SUB-091 viewer-mode toggle can write role_override against the
	// exact session that made the request.
	SessionID string
	MFAOK     bool
	// MFAAt is when that proof was given; zero when unknown.
	MFAAt time.Time
}

// Resolver looks up a session row by cookie and projects it into
// ResolvedSession. ResolveSession returns (nil, nil) when the cookie
// is absent or malformed — the middleware should fall through to
// other auth paths. Stale cookies (expired / revoked) return a
// non-nil err; the middleware adapter clears the cookie on those.
type Resolver struct {
	Repo *Repo
	// LookupTenantAndUser must fetch the cosmetic tenant fields +
	// user role given (tenantID, userID) — Repo's pre-tenant lookups
	// don't read the tenants table for slug/name/tier. Provided by
	// main.go so we don't widen Repo for one query.
	LookupTenantAndUser func(ctx context.Context, tenantID, userID string) (
		tenantSlug, tenantName, tenantTier, userEmail, userRole string,
		err error,
	)
}

// ResolveSession parses the cookie, validates the session, and
// projects the result. The resolver is responsible for keeping
// last_seen_at fresh.
func (rs *Resolver) ResolveSession(r *http.Request) (*ResolvedSession, error) {
	tok, err := ParseSessionCookie(r)
	if err != nil {
		// No cookie or malformed — not an error to escalate.
		if errors.Is(err, ErrNoSession) {
			return nil, nil
		}
		return nil, err
	}
	sess, err := rs.Repo.LookupSession(r.Context(), tok.ID, tok.Verifier)
	if err != nil {
		// ErrSessionExpired and ErrSessionRevoked surface upward so
		// the middleware adapter can ClearSessionCookie. ErrNotFound
		// (which covers "no row" + "verifier mismatch") collapses to
		// nil so we don't leak which one happened via timing.
		if errors.Is(err, ErrSessionExpired) || errors.Is(err, ErrSessionRevoked) {
			return nil, err
		}
		return nil, nil
	}

	tenantSlug, tenantName, tenantTier, userEmail, userRole, err :=
		rs.LookupTenantAndUser(r.Context(), sess.TenantID, sess.UserID)
	if err != nil {
		return nil, err
	}

	// Bump last_seen_at (rate-limited internally to once per minute).
	_ = rs.Repo.TouchSession(r.Context(), sess.ID)

	// SUB-091: surface the per-session effective role. The override is
	// only honored when it is a strict DOWNGRADE of the durable role —
	// a stale or tampered override that would escalate is ignored so the
	// preview affordance can never widen permissions. Down-only is also
	// enforced at write time in ToggleViewerMode; this is defense in depth.
	//
	// roleRank orders most-privileged (owner=0) to least (viewer=3), so a
	// strict downgrade means the override's rank is GREATER than the
	// durable role's rank. (A bug here previously used `<`, which inverted
	// the test so an admin→viewer override never applied — SUB-091.)
	effectiveRole := resolveEffectiveRole(userRole, sess.RoleOverride)

	return &ResolvedSession{
		TenantID:      sess.TenantID,
		TenantSlug:    tenantSlug,
		TenantName:    tenantName,
		TenantTier:    tenantTier,
		UserID:        sess.UserID,
		UserEmail:     userEmail,
		UserRole:      userRole,
		EffectiveRole: effectiveRole,
		SessionID:     sess.ID,
		MFAOK:         sess.MFASatisfied,
		MFAAt:         sess.MFASatisfiedAt,
	}, nil
}

// resolveEffectiveRole computes the per-session effective role from the
// durable role and an optional SUB-091 role_override. The override is
// honored ONLY when it is a strict DOWNGRADE of the durable role — i.e.
// strictly less privileged (a GREATER roleRank). An empty override, an
// equal-or-higher-privilege override, or an unknown durable role all
// fall back to the durable role, so the View-as-Viewer preview can only
// ever narrow access, never widen it.
func resolveEffectiveRole(durableRole, override string) string {
	if override != "" && roleRank(override) > roleRank(durableRole) {
		return override
	}
	return durableRole
}

// roleRank orders the role vocabulary from most-privileged (owner) to
// least (viewer) so the resolver + the viewer-mode toggle can enforce a
// strict down-only override: a lower rank = higher privilege. Unknown
// roles rank below viewer so they can never be the target of an
// escalation comparison. Mirrors the CHECK vocabulary on
// auth_sessions.role_override (migration 1524).
func roleRank(role string) int {
	switch role {
	case "owner":
		return 0
	case "admin":
		return 1
	case "editor":
		return 2
	case "viewer":
		return 3
	default:
		return 99
	}
}
