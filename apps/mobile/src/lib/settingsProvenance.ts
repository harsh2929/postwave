/**
 * lib/settingsProvenance.ts — "who changed this, and when".
 *
 * GET /api/v1/settings/workspace and /settings/privacy have always returned
 * `updated_at` and `updated_by_user_id`; the mobile client typed both and
 * rendered neither. In a workspace with more than one admin, "who turned this
 * off and when" is the first question asked about any policy setting, and the
 * answer was on the wire the whole time.
 *
 * HONESTY RULE: mobile has no roster endpoint wired, so a user id cannot be
 * resolved to a name. Inventing "by an administrator" would be an unfounded
 * claim (it could have been an API key or a migration). The only attribution
 * this module makes is the one it can prove — that the id equals the signed-in
 * user — and otherwise it reports the timestamp alone.
 *
 * Import-free so the rule is testable in the node environment.
 */

export interface SettingsProvenance {
  updatedAt?: string | null | undefined;
  updatedByUserId?: string | null | undefined;
  /** The signed-in user's id, when known. */
  currentUserId?: string | null | undefined;
}

/**
 * Returns the muted line to render under an admin card, or null when the
 * server gave us nothing worth saying.
 *
 * `relative` is injected rather than imported so this module stays free of the
 * formatting layer and the caller keeps one relative-time implementation
 * (src/lib/format.ts).
 */
export function provenanceLabel(
  input: SettingsProvenance,
  relative: (value: unknown) => string,
): string | null {
  const at = typeof input.updatedAt === "string" ? input.updatedAt.trim() : "";
  if (!at) return null;
  const when = relative(at);
  // A formatter that could not parse the value returns its em-dash fallback;
  // "Updated —" is worse than no line at all.
  if (!when || when === "—") return null;
  const by =
    typeof input.updatedByUserId === "string" ? input.updatedByUserId.trim() : "";
  const me =
    typeof input.currentUserId === "string" ? input.currentUserId.trim() : "";
  if (by && me && by === me) return `Updated ${when} by you`;
  return `Updated ${when}`;
}
