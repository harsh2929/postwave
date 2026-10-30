/**
 * lib/campaignAccess.ts — who may do what to a campaign, decided before the
 * UI renders rather than by a 403 after the tap.
 *
 * Mobile computed `canMutateCampaign = online && !gateNotice` — connectivity
 * only, with no role term — so a read-only viewer got a full-strength
 * destructive UI (Send now, Delete) and learned otherwise from a raw server
 * error in an Alert. Desktop computes canMutate/canAdmin and renders an
 * explanatory reason instead.
 *
 * `effectiveRole` is already surfaced by useOnlineQueryGate and is the same
 * value the tab navigator uses for tab access.
 *
 * Admin-only actions mirror the server's own scope requirements:
 *   - clone           → ScopeAdmin (apps/api/internal/campaign_clone)
 *   - save-as-template→ ScopeAdmin (apps/api/internal/campaign_to_template)
 */

export type CampaignAccessReason =
  | "ok"
  | "offline"
  | "session"
  | "viewer"
  | "admin_only";

export interface CampaignAccess {
  /** Editor+ — may edit, schedule, send, delete. */
  canMutate: boolean;
  /** Admin only — clone, save-as-template. */
  canAdmin: boolean;
  reason: CampaignAccessReason;
  /** Copy explaining a denial, or null when nothing is denied. */
  notice: string | null;
}

const VIEWER_ROLES = new Set(["viewer", "read_only", "readonly", "guest"]);
const ADMIN_ROLES = new Set(["admin", "owner", "superadmin", "super_admin"]);

export function isViewerRole(role: string | null | undefined): boolean {
  return VIEWER_ROLES.has((role ?? "").trim().toLowerCase());
}

export function isAdminRole(role: string | null | undefined): boolean {
  return ADMIN_ROLES.has((role ?? "").trim().toLowerCase());
}

/**
 * Routes guarded by RequireExactTenantAdmin accept only the effective owner or
 * admin role. They deliberately reject broader aliases and additive grants.
 */
export function isExactTenantAdminRole(
  role: string | null | undefined,
): boolean {
  const exact = (role ?? "").trim().toLowerCase();
  return exact === "admin" || exact === "owner";
}

export interface CampaignAccessInput {
  /** Device connectivity. */
  online: boolean;
  /** False when the session is cached/blocked (CachedSessionNotice present). */
  sessionUsable: boolean;
  effectiveRole: string | null | undefined;
}

/**
 * The single decision the campaign screens consult.
 *
 * Order matters: an offline viewer should be told about their role, not just
 * about connectivity, because reconnecting will not grant them Send.
 */
export function campaignAccess(input: CampaignAccessInput): CampaignAccess {
  const admin = isAdminRole(input.effectiveRole);

  if (isViewerRole(input.effectiveRole)) {
    return {
      canMutate: false,
      canAdmin: false,
      reason: "viewer",
      notice:
        "You have read-only access to this workspace. Ask an editor or admin to change, schedule, or send this campaign.",
    };
  }
  if (!input.sessionUsable) {
    return {
      canMutate: false,
      canAdmin: false,
      reason: "session",
      notice:
        "You're viewing cached data. Sign in again to change, schedule, or send this campaign.",
    };
  }
  if (!input.online) {
    return {
      canMutate: false,
      canAdmin: false,
      reason: "offline",
      notice:
        "You're offline. Sending and scheduling need a connection — subject edits you make will be queued and replayed.",
    };
  }
  return { canMutate: true, canAdmin: admin, reason: "ok", notice: null };
}

/** Explanation for an action that requires an admin, for an editor-level user. */
export const CAMPAIGN_ADMIN_ONLY_NOTICE =
  "Duplicating and saving as a template are admin-only in this workspace.";
