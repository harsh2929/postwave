// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Role gates for the list workspace, read the way the lists index reads them
 * (`whoami` + `effectiveAuthRole`, viewer mode withholds every write).
 *
 * Settings follow the index page (owner / admin / editor). Membership follows
 * the desktop MembersTab, which gates add/remove by admin. Merge fields ride
 * the write:subscribers scope (editor and up, like desktop's useCanWrite);
 * list-scoped webhooks are admin-only on the server for reads AND writes
 * (webhooks.go mounts the whole surface under ScopeAdmin), so the tab is
 * withheld entirely below admin — no webhook data is requested.
 */
import {
  effectiveAuthRole,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

export const SETTINGS_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];
export const MEMBERSHIP_ROLES: readonly AuthRole[] = ["owner", "admin"];
export const MERGE_FIELD_ROLES: readonly AuthRole[] = SETTINGS_ROLES;
export const WEBHOOK_ROLES: readonly AuthRole[] = MEMBERSHIP_ROLES;

export const SETTINGS_REASON =
  "Viewer access is read-only; an editor or admin can change list settings.";
export const MEMBERSHIP_REASON =
  "Admin role required to change list membership.";
export const MERGE_FIELD_REASON =
  "Viewer access is read-only; an editor or admin can change merge fields.";
export const WEBHOOK_REASON =
  "Webhook destinations, delivery evidence, test sends and signing material are restricted to workspace admins. No webhook data was requested.";

export function roleAllows(
  me: MeResponse | undefined,
  allowed: readonly AuthRole[],
): boolean {
  return Boolean(
    me && !me.viewer_mode && allowed.includes(effectiveAuthRole(me)),
  );
}

/**
 * Compare the identity the page rendered with against a fresh read taken
 * immediately before a write, so a workspace switch or role change in another
 * tab never lands a write under stale authority.
 */
export function assertWriteIdentity(
  old: MeResponse,
  fresh: MeResponse,
  allowed: readonly AuthRole[],
  requirement: string,
): void {
  if (
    old.user_id !== fresh.user_id ||
    old.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(old) !== effectiveAuthRole(fresh) ||
    fresh.viewer_mode
  )
    throw new Error(
      "Your workspace authority changed. Nothing was written; refresh and retry.",
    );
  if (!allowed.includes(effectiveAuthRole(fresh))) throw new Error(requirement);
}
