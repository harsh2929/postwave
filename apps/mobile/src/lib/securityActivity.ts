/**
 * The "recent security activity" projection for the Settings screen (AUTH#8b).
 *
 * Half of AUTH#8 shipped in an earlier round: `SECURITY_ACTION_KEYWORDS` +
 * `isSecurityAction` in lib/auditViews.ts give the audit tab a named one-tap
 * Security lens. The half that did NOT ship is the one apps/web has and
 * explicitly justifies (settings/security/security-activity-card.tsx): the
 * top matching rows inlined NEXT TO the security controls, so a user checking
 * "did anyone else sign in?" does not have to leave the screen they are on,
 * find a different tab, and re-derive the filter.
 *
 * Import-free (no react-native, no expo) so every rule below is testable in
 * the node vitest environment.
 */

/** Shape needed from an audit row. Structural so the hook's type flows in. */
export interface SecurityActivityRow {
  id: number;
  action: string;
  actorLabel?: string | null;
  actorType?: string;
  ip?: string | null;
  at: string;
}

/** What web shows. Kept small on purpose: this is a glance, not the log. */
export const SECURITY_ACTIVITY_LIMIT = 5;

/**
 * The most recent security rows, newest first.
 *
 * Rows are sorted here rather than trusted in wire order: the audit list is
 * paged by cursor and a caller may hand over several concatenated pages, and
 * "most recent" is the only ordering this card's copy claims.
 */
export function recentSecurityActivity<T extends SecurityActivityRow>(
  rows: readonly T[] | undefined,
  isSecurity: (action: string) => boolean,
  limit = SECURITY_ACTIVITY_LIMIT,
): T[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => isSecurity(row.action))
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, Math.max(0, limit));
}

/**
 * The human line for one row: who did what, and from where when we know.
 *
 * `actorLabel` is nullable on the wire and `ip` is frequently absent (an
 * agent/API-key actor has none), so neither is invented — an unknown actor
 * says "Unknown actor" rather than rendering an empty string that reads as a
 * layout bug.
 */
export function securityActorLine(row: SecurityActivityRow): string {
  const actor = (row.actorLabel ?? "").trim();
  const who = actor || (row.actorType ?? "").trim() || "Unknown actor";
  const ip = (row.ip ?? "").trim();
  return ip ? `${who} · ${ip}` : who;
}

/**
 * Turn a machine action token into a sentence fragment.
 *
 * `user.login.succeeded` → "User login succeeded". Deliberately mechanical:
 * inventing a curated label map here would drift from the audit tab's own
 * rendering of the SAME row, and two different names for one event is worse
 * than one slightly clumsy name.
 */
export function securityActionLabel(action: string): string {
  const cleaned = (action ?? "").trim();
  if (!cleaned) return "Unknown action";
  const words = cleaned.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the card says when there is nothing to show, per outcome. */
export type SecurityActivityState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "rows" };

/**
 * The state ladder, as a decision rather than as nested ternaries in JSX.
 *
 * The rung that matters: a FAILED or OFFLINE read must never render as
 * "No recent security activity". "We could not look" and "nothing happened"
 * are opposite reassurances, and this card exists to reassure.
 */
export function securityActivityState(input: {
  /** null = the audit:read scope answer has not arrived yet. */
  canRead: boolean | null;
  online: boolean;
  loading: boolean;
  failed: boolean;
  rowCount: number;
}): SecurityActivityState {
  // No scope, or the answer is still in flight: the audit tab already owns
  // the explanation, so Settings stays quiet rather than duplicating it.
  if (input.canRead !== true) return { kind: "hidden" };
  if (input.failed) {
    return {
      kind: "failed",
      message: "Couldn't read recent security activity.",
    };
  }
  if (input.rowCount > 0) return { kind: "rows" };
  if (input.loading) return { kind: "loading" };
  if (!input.online) {
    return {
      kind: "failed",
      message: "You're offline, so recent security activity can't be checked.",
    };
  }
  return {
    kind: "empty",
    message: "No sign-ins, password changes or token grants in this window.",
  };
}
