/**
 * lib/scimMappingPolicy.ts — the pure half of SCIM role-mapping writes.
 *
 * A role mapping decides which workspace role an IdP group resolves to at
 * SSO/JIT time (scim/role_mappings.go ResolveRoleFromGroupNames): mappings
 * are sorted by precedence and the FIRST match wins, `*` is the catch-all.
 * A wrong mapping is therefore a privilege-escalation bug an operator may
 * need to correct from the road — the reason the delete verb exists here.
 *
 * VALIDATION MIRRORS UpsertRoleMapping: group_name required (trimmed),
 * role ∈ owner|admin|editor|viewer, precedence outside 0..1000 is coerced by
 * the server to 100 — this module refuses instead of silently coercing, so
 * what the operator confirmed is what is stored.
 *
 * Import-free, so it runs under node vitest.
 */

export const SCIM_MAPPING_ROLES = [
  "viewer",
  "editor",
  "admin",
  "owner",
] as const;
export type ScimMappingRole = (typeof SCIM_MAPPING_ROLES)[number];

export const SCIM_PRECEDENCE_DEFAULT = 100;

export interface ScimMappingDraft {
  groupName: string;
  role: string;
  precedence: string;
}

/** null when the draft would be stored as-is; otherwise the sentence to show. */
export function scimMappingIssue(draft: ScimMappingDraft): string | null {
  if (!draft.groupName.trim()) {
    return "An IdP group name is required ('*' is the catch-all).";
  }
  if (!SCIM_MAPPING_ROLES.includes(draft.role as ScimMappingRole)) {
    return "Pick one of the four workspace roles.";
  }
  const precedence = Number(draft.precedence.trim() || SCIM_PRECEDENCE_DEFAULT);
  if (!Number.isInteger(precedence) || precedence < 0 || precedence > 1000) {
    return "Precedence must be a whole number between 0 and 1000.";
  }
  return null;
}

/** The parsed precedence a valid draft stores. */
export function scimMappingPrecedence(draft: ScimMappingDraft): number {
  const raw = draft.precedence.trim();
  return raw === "" ? SCIM_PRECEDENCE_DEFAULT : Number(raw);
}

/**
 * Said above the confirm for an owner/admin grant: the blast radius is the
 * whole IdP group, applied at each member's next SSO login.
 */
export function scimUpsertConsequence(draft: ScimMappingDraft): string | null {
  if (draft.role !== "owner" && draft.role !== "admin") return null;
  const group = draft.groupName.trim();
  const subject =
    group === "*"
      ? "EVERY user who signs in through the IdP"
      : `every member of “${group}”`;
  return `This grants workspace-${draft.role} to ${subject} at their next SSO sign-in.`;
}

/** The confirm copy for deleting a mapping. */
export function scimDeleteConsequence(
  groupName: string,
  role: string,
): string {
  const group = (groupName ?? "").trim();
  if (group === "*") {
    return `Removes the catch-all rule (currently ${role}). Users in no mapped group will fall back to the server's default resolution at next sign-in. The rule can be re-added at any time.`;
  }
  return `Members of “${group}” will no longer resolve to ${role} at sign-in — the next matching rule (or the catch-all) decides instead. The rule can be re-added at any time.`;
}

/**
 * The server upserts on (tenant, group_name): submitting a changed group
 * name creates a NEW rule and leaves the old one standing. The sheet says
 * this whenever an edit renames the group.
 */
export const SCIM_RENAME_NOTICE =
  "Changing the group name creates a new rule — the old group's rule stays until you delete it.";
