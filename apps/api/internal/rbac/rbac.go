// SPDX-License-Identifier: AGPL-3.0-only
//
// Package rbac is the first-class role→permission model the platform lacked
// (frontier G-48).
//
// Before this, authorization for dashboard (session-cookie) users was a set of
// ad-hoc scope allowlists scattered through apikeys/middleware.go: read-only
// scopes passed for anyone, two content-write scopes passed for "editor", and
// everything else required owner/admin. There was no capability vocabulary, no
// single place that answered "what can this role do", and — the register's
// headline defect — no way to express "may edit campaigns but not billing":
// editor and viewer were effectively indistinguishable outside those two
// hardcoded scopes, and a custom role could not be defined at all.
//
// This package is the canonical model those pieces generalize to. It defines
// the platform's permission vocabulary, the built-in role grants, and a
// RequirePermission middleware routes adopt for fine-grained gating. It is
// deliberately storage-free and dependency-free (no imports of apikeys /
// middleware) so it can be the shared source of truth without cycles.
//
// SCOPE — this is the FOUNDATION, not the whole feature. Still ahead (and
// genuinely multi-week): persisting tenant-defined custom roles (a
// role_permissions table + CRUD), migrating every route from RequireScope to
// RequirePermission, object-level / per-list scoping, and the settings UI.
package rbac

import (
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"net/http"
	"sort"
	"strings"
)

// Permission is a single capability an actor may or may not hold. The vocabulary
// is intentionally finer than the API-key Scope set (which conflates all
// admin-tier power into one "admin" scope) so a custom role can grant, say,
// campaign editing without billing — the exact case G-48 says is inexpressible.
type Permission string

const (
	PermSubscribersRead   Permission = "subscribers.read"
	PermSubscribersWrite  Permission = "subscribers.write"
	PermCampaignsRead     Permission = "campaigns.read"
	PermCampaignsWrite    Permission = "campaigns.write"
	PermReportsRead       Permission = "reports.read"
	PermTransactionalSend Permission = "transactional.send"
	PermAuditRead         Permission = "audit.read"
	PermAuditReadPII      Permission = "audit.read_pii"
	PermAuditReadAll      Permission = "audit.read_all_tenants"
	PermAuditConfigure    Permission = "audit.configure"
	PermAuditExecute      Permission = "audit.execute"
	PermBillingManage     Permission = "billing.manage"
	PermAPIKeysManage     Permission = "apikeys.manage"
	PermDomainsManage     Permission = "domains.manage"
	PermMembersManage     Permission = "members.manage"
	// PermMCPInvoke models ScopeMCP: admission to the native MCP RPC endpoint.
	// It is an ADMISSION permission rather than a data one — the endpoint runs
	// its own per-tool scope checks inside the JSON-RPC frame, so holding this
	// grants the ability to drive an MCP client and nothing about what that
	// client may then read or write.
	//
	// Admin-tier, because that is what the live session path already decides:
	// ScopeMCP is absent from `readOnlyScopes`, and `requireAdminRoleForScopes`
	// treats anything not on that allow-list as admin. This constant makes the
	// model agree with the enforcement rather than introducing a new rule.
	PermMCPInvoke Permission = "mcp.invoke"
	// PermAccountManage is the owner-exclusive lever (ownership transfer /
	// closing the account) that even a full admin does not hold.
	PermAccountManage Permission = "account.manage"
)

// allPermissions is the full vocabulary, in a stable order.
var allPermissions = []Permission{
	PermSubscribersRead, PermSubscribersWrite,
	PermCampaignsRead, PermCampaignsWrite,
	PermReportsRead, PermTransactionalSend,
	PermAuditRead, PermAuditReadPII, PermAuditReadAll,
	PermAuditConfigure, PermAuditExecute,
	PermBillingManage, PermAPIKeysManage, PermDomainsManage,
	PermMembersManage, PermAccountManage,
}

// Role is a built-in role name (matches users.role values, lower-case).
type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
	RoleMember Role = "member"
)

// readOnly is the set every non-guest role holds.
var readOnly = []Permission{
	PermSubscribersRead, PermCampaignsRead, PermReportsRead, PermAuditRead,
}

// editorExtra is what "editor" adds on top of read-only: content authoring.
// This mirrors the live editorWriteScopes carve-out (write:subscribers /
// write:campaigns) so the model and the existing session authz agree; the
// rbac_bridge_test consistency check pins that agreement.
var editorExtra = []Permission{PermSubscribersWrite, PermCampaignsWrite}

// adminExtra is what "admin" adds on top of editor: every privileged lever
// except the owner-exclusive account lever.
var adminExtra = []Permission{
	PermTransactionalSend, PermAuditReadPII, PermAuditReadAll,
	PermAuditConfigure, PermAuditExecute,
	PermBillingManage, PermAPIKeysManage, PermDomainsManage, PermMembersManage,
	PermMCPInvoke,
}

// roleGrants is the built-in role→permission matrix, resolved once at init so
// Can() is an O(1) map lookup.
var roleGrants = buildGrants()

func buildGrants() map[Role]map[Permission]bool {
	viewer := permSet(readOnly...)
	member := permSet(readOnly...)
	editor := union(viewer, editorExtra...)
	admin := union(editor, adminExtra...)
	owner := union(admin, PermAccountManage)
	return map[Role]map[Permission]bool{
		RoleViewer: viewer,
		RoleMember: member,
		RoleEditor: editor,
		RoleAdmin:  admin,
		RoleOwner:  owner,
	}
}

func permSet(perms ...Permission) map[Permission]bool {
	m := make(map[Permission]bool, len(perms))
	for _, p := range perms {
		m[p] = true
	}
	return m
}

func union(base map[Permission]bool, extra ...Permission) map[Permission]bool {
	out := make(map[Permission]bool, len(base)+len(extra))
	for p := range base {
		out[p] = true
	}
	for _, p := range extra {
		out[p] = true
	}
	return out
}

// normalizeRole lower-cases and trims a role string so " Editor " matches.
func normalizeRole(role string) Role {
	return Role(strings.ToLower(strings.TrimSpace(role)))
}

// Can reports whether a role holds a permission. Unknown or empty roles hold
// nothing (fail closed) — a role the model doesn't recognize must never be
// granted a privileged capability by default.
func Can(role string, perm Permission) bool {
	grants, ok := roleGrants[normalizeRole(role)]
	if !ok {
		return false
	}
	return grants[perm]
}

// PermissionsForRole returns the sorted permissions a role holds (empty for an
// unknown role). Used by the settings UI to render "what can each role do".
func PermissionsForRole(role string) []Permission {
	grants, ok := roleGrants[normalizeRole(role)]
	if !ok {
		return nil
	}
	out := make([]Permission, 0, len(grants))
	for p := range grants {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// AllPermissions returns the full permission vocabulary in a stable order.
func AllPermissions() []Permission {
	out := make([]Permission, len(allPermissions))
	copy(out, allPermissions)
	return out
}

// RoleDescriptor is the UI-facing shape of a built-in role and its grants.
type RoleDescriptor struct {
	Role        Role         `json:"role"`
	Label       string       `json:"label"`
	Permissions []Permission `json:"permissions"`
}

// BuiltInDescriptors returns the built-in roles with their permissions, in
// descending-privilege order — the payload a roles-settings screen renders.
func BuiltInDescriptors() []RoleDescriptor {
	order := []struct {
		role  Role
		label string
	}{
		{RoleOwner, "Owner"},
		{RoleAdmin, "Admin"},
		{RoleEditor, "Editor"},
		{RoleViewer, "Viewer"},
		{RoleMember, "Member"},
	}
	out := make([]RoleDescriptor, 0, len(order))
	for _, o := range order {
		out = append(out, RoleDescriptor{
			Role:        o.role,
			Label:       o.label,
			Permissions: PermissionsForRole(string(o.role)),
		})
	}
	return out
}

// RequirePermission gates a route on a single permission for session-cookie
// users. roleOf extracts the caller's role from the request (returning ok=false
// when there is no authenticated principal) — passing it in keeps rbac free of
// any dependency on the middleware/apikeys packages, avoiding an import cycle.
// A missing principal is 401; an insufficient role is 403.
func RequirePermission(perm Permission, roleOf func(*http.Request) (string, bool)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, ok := roleOf(r)
			if !ok {
				writeForbidden(w, http.StatusUnauthorized, "missing_principal",
					"an authenticated dashboard user is required")
				return
			}
			if !Can(role, perm) {
				// The shared denial contract. This is THE permission chokepoint,
				// and it used to emit a hand-concatenated envelope with no
				// machine-readable class — so a client could not distinguish
				// "your plan does not include this" from "your role does not
				// permit this", which is how a paywall gets shown to someone who
				// needs an admin to change their role.
				entitlement.Write(w, entitlement.Denial{
					Subject:      string(perm),
					Reason:       entitlement.ReasonRole,
					Code:         "insufficient_permission",
					Message:      "your role does not have the " + string(perm) + " permission",
					RequiredRole: string(LeastRoleWith(perm)),
					// No remedy: buying a bigger plan does not grant a permission,
					// and the caller cannot self-serve a role change. An empty
					// remedy says exactly that, which is more useful than a button
					// that cannot work.
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// LeastRoleWith returns the lowest-privilege built-in role holding perm, or ""
// when no role does.
//
// Derived from the SAME `roleGrants` matrix `Can` consults, so a denial cannot
// name a role that would itself be refused — a hand-maintained "ask an admin"
// string would drift the moment a permission moved between roles.
//
// Lowest-privilege on purpose: telling a viewer to become an owner when editor
// suffices asks for more access than the task needs, and that is how privilege
// creeps.
func LeastRoleWith(perm Permission) Role {
	// Ordered least- to most-privileged.
	for _, role := range []Role{RoleViewer, RoleMember, RoleEditor, RoleAdmin, RoleOwner} {
		if Can(string(role), perm) {
			return role
		}
	}
	return ""
}

func writeForbidden(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":{"code":"` + code + `","message":"` + message + `"}}`))
}
