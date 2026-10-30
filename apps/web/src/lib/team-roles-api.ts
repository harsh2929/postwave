// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the role × audit-scope matrix. Backend:
// apps/api/internal/handlers/audit_rbac.go — GET /api/v1/roles (owner read)
// and PUT /api/v1/roles/{id}/scopes (ScopeAdmin). This mirrors the desktop
// "Team roles matrix (role × audit-scope) edit". The web UI gates the edit
// controls behind owner/admin from whoami.

import { api } from "@/lib/api";

export interface RoleWithScopes {
  id: string;
  name: string;
  description: string;
  assignedScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RolesResponse {
  roles: RoleWithScopes[];
  availableScopes: string[];
}

export function listRoles(options?: {
  signal?: AbortSignal;
}): Promise<RolesResponse> {
  return api
    .get<Partial<RolesResponse>>("/api/v1/roles", options)
    .then((r) => ({
      roles: r.roles ?? [],
      availableScopes: r.availableScopes ?? [],
    }));
}

export function updateRoleScopes(
  roleId: string,
  scopes: string[],
  options?: {
    signal?: AbortSignal;
    requireOnline?: boolean;
    maxAttempts?: number;
  },
): Promise<unknown> {
  return api.put(
    `/api/v1/roles/${encodeURIComponent(roleId)}/scopes`,
    { scopes: dedupeScopes(scopes) },
    options,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Trims, drops empties, and dedupes a scope list (preserving first-seen
 * order) so the PUT body matches what the API will store. */
export function dedupeScopes(scopes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of scopes) {
    const s = (raw ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Toggles a single scope in a role's set, returning the new deduped list. */
export function toggleScope(
  current: string[],
  scope: string,
  enabled: boolean,
): string[] {
  const set = new Set(dedupeScopes(current));
  if (enabled) set.add(scope);
  else set.delete(scope);
  return [...set];
}

/** Friendly label for an audit-scope string (e.g. "audit:read" → "Read"). */
export function scopeLabel(scope: string): string {
  const tail = scope.includes(":")
    ? scope.split(":").slice(1).join(":")
    : scope;
  return tail
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function titleCase(segment: string): string {
  return segment
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Disambiguated column header that keeps the scope's action prefix so
 * `read:subscribers` and `write:subscribers` no longer both render as
 * "Subscribers" (SETC-013). Returns e.g. "Subscribers (read)".
 */
export function scopeHeaderLabel(scope: string): string {
  if (!scope.includes(":")) return titleCase(scope);
  const [prefix, ...rest] = scope.split(":");
  const tail = rest.join(":");
  if (!tail) return titleCase(prefix);
  return `${titleCase(tail)} (${titleCase(prefix).toLowerCase()})`;
}

/**
 * True for scopes that grant broad audit/admin power and therefore warrant a
 * confirm before granting (SETC-015). Reversible + owner-only, so revoking and
 * non-privileged scopes stay one-click.
 */
export function isPrivilegedScope(scope: string): boolean {
  const tail = (
    scope.includes(":") ? scope.split(":").slice(1).join(":") : scope
  ).toLowerCase();
  if (scope.toLowerCase() === "admin" || tail === "admin") return true;
  return (
    tail === "read_all_tenants" ||
    tail === "execute_actions" ||
    tail.startsWith("configure_")
  );
}
