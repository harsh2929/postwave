// SPDX-License-Identifier: AGPL-3.0-only

import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";

export const ADMIN_READ_ONLY_MESSAGE =
  "This workspace data is available only to owners and admins outside viewer mode.";

export function canReadAdminData(
  identity: MeResponse | null | undefined,
): boolean {
  if (!identity || identity.viewer_mode === true) return false;
  const role = effectiveAuthRole(identity);
  return role === "owner" || role === "admin";
}

export function adminReadIdentityParts(
  identity: MeResponse | null | undefined,
): readonly [string, string, string, string] {
  return [
    identity?.tenant_id ?? "anon",
    identity?.user_id ?? "anon",
    identity ? effectiveAuthRole(identity) : "none",
    identity?.viewer_mode === true ? "viewer-mode" : "durable-mode",
  ];
}
