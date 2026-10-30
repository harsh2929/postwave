/**
 * lib/workspaceRoles.ts — the pure half of mobile's read-only roles card.
 *
 * Desktop renders RolesSection (apps/desktop/src/components/settings/
 * sections.tsx) from GET /api/v1/roles; mobile had NO caller for that route —
 * the only mention was a comment in api/approvalGovernance.ts. So "which role
 * can do what" was unanswerable from a phone, which is exactly the question
 * behind half the "why can't my colleague see X" confusions.
 *
 * WIRE SHAPE, read off the Go handler (audit_rbac.go:91 RoleWithScopes /
 * :107 ListRoles): camelCase keys, unlike most of the settings families —
 *   { roles: [{id, name, description, assignedScopes, createdAt, updatedAt}],
 *     availableScopes: [] }
 * `assignedScopes` is never null on the wire, but the normalizer does not
 * trust that.
 *
 * READ-ONLY, DELIBERATELY. PUT /roles/{id}/scopes exists (admin) but editing a
 * role's scope set from a phone re-permissions every member holding the role;
 * that stays on the web admin, the same reasoning platformConfig.ts records.
 *
 * Import-free so it runs under node vitest.
 */

export interface WorkspaceRoleView {
  id: string;
  name: string;
  description: string;
  /** Scope strings, as assigned. Empty for a role that can only sign in. */
  scopes: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** `{roles: [...]}` → the rows a card can render. Rows with no id are junk. */
export function normalizeWorkspaceRoles(payload: unknown): WorkspaceRoleView[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.roles) ? raw.roles : [];
  const out: WorkspaceRoleView[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      description: str(r.description),
      scopes: strList(r.assignedScopes),
    });
  }
  return out;
}

/**
 * One role's scope list as a readable line. Scope strings are machine tokens
 * ("read:subscribers"); the card renders them verbatim but bounded, because a
 * role holding every scope would otherwise become a paragraph.
 */
export function roleScopeSummary(role: WorkspaceRoleView, max = 6): string {
  if (role.scopes.length === 0) return "No scopes assigned";
  const shown = role.scopes.slice(0, max);
  const rest = role.scopes.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}
