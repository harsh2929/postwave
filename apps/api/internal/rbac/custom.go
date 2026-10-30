// SPDX-License-Identifier: AGPL-3.0-only
//
// custom.go — the resolution + validation layer that lets tenant-defined
// custom roles sit alongside the built-in matrix (frontier G-48, continued).
//
// The built-in roles (rbac.go) are the fixed floor. This adds the semantics a
// persisted role_permissions table needs on top: validate a role's grant list
// against the known vocabulary (fail closed), and resolve any role name — built
// in OR custom — to an effective permission set. Storage lives in store.go; the
// logic here is deliberately pure so it is fully unit-tested without a database.
package rbac

import (
	"fmt"
	"strings"
)

// permissionByValue indexes the vocabulary for O(1) validation.
var permissionByValue = func() map[string]Permission {
	m := make(map[string]Permission, len(allPermissions))
	for _, p := range allPermissions {
		m[string(p)] = p
	}
	return m
}()

// ParsePermissions validates raw permission strings (e.g. from a custom-role
// API payload or the role_permissions table) against the known vocabulary,
// returning the typed permissions. It fails closed: any unknown or empty value
// is an error naming every offender, so a typo or an injected string can never
// become a silent grant.
func ParsePermissions(raw []string) ([]Permission, error) {
	out := make([]Permission, 0, len(raw))
	var unknown []string
	for _, r := range raw {
		key := strings.TrimSpace(r)
		if p, ok := permissionByValue[key]; ok {
			out = append(out, p)
		} else {
			unknown = append(unknown, r)
		}
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("rbac: unknown permission(s): %s", strings.Join(unknown, ", "))
	}
	return out, nil
}

// IsBuiltInRole reports whether a role name is one of the fixed built-in roles.
// A custom role may not reuse a built-in name (enforced at write time), and
// ResolveGrants always resolves built-in names from the matrix regardless of
// any custom rows — a tenant must not be able to redefine "admin".
func IsBuiltInRole(role string) bool {
	_, ok := roleGrants[normalizeRole(role)]
	return ok
}

// ResolveGrants returns the effective permission set for a role. Built-in roles
// resolve from the matrix (custom rows of the same name are ignored, so a
// built-in role can never be shadowed). Otherwise the role is looked up in the
// supplied custom map (a tenant's role_permissions, keyed by role name). An
// unrecognized role resolves to the empty set — fail closed.
func ResolveGrants(role string, custom map[string][]Permission) map[Permission]bool {
	norm := normalizeRole(role)
	if grants, ok := roleGrants[norm]; ok {
		// Return a copy so callers cannot mutate the shared matrix.
		out := make(map[Permission]bool, len(grants))
		for p := range grants {
			out[p] = true
		}
		return out
	}
	for name, perms := range custom {
		if normalizeRole(name) == norm {
			return permSet(perms...)
		}
	}
	return map[Permission]bool{}
}

// CanGrants reports whether a resolved grant set holds a permission. Pairs with
// ResolveGrants so an enforcement site can check a custom role without a second
// resolution.
func CanGrants(grants map[Permission]bool, perm Permission) bool {
	return grants[perm]
}
