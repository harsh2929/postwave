// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

export type CustomFieldAuthorityLevel = "field" | "mode";

const FIELD_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];
const MODE_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin"];

export function canEditCustomFields(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    FIELD_WRITE_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function canAdminCustomFieldMode(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    MODE_WRITE_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function customFieldAuthorityKey(
  identity: MeResponse | null | undefined,
): string {
  if (!identity) return "unverified";
  return [
    identity.tenant_id,
    identity.user_id,
    effectiveAuthRole(identity),
    identity.viewer_mode === true ? "viewer" : "member",
  ].join(":");
}

export async function verifyFreshCustomFieldAuthority(
  opened: MeResponse,
  level: CustomFieldAuthorityLevel,
  signal?: AbortSignal,
): Promise<void> {
  const fresh = await whoamiFresh(signal);
  const allowed =
    level === "mode" ? canAdminCustomFieldMode : canEditCustomFields;
  if (
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    Boolean(opened.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    !allowed(opened) ||
    !allowed(fresh)
  ) {
    throw new Error(
      "Workspace identity or custom-field authority changed. Nothing was written; reload and retry.",
    );
  }
}
