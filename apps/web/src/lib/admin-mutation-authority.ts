// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { roleCanWrite } from "@/lib/use-admin-gate";

export class FreshAdminAuthorityError extends Error {
  readonly freshIdentity: MeResponse;
  readonly reason: "changed" | "forbidden";

  constructor(
    reason: "changed" | "forbidden",
    message: string,
    freshIdentity: MeResponse,
  ) {
    super(message);
    this.name = "FreshAdminAuthorityError";
    this.reason = reason;
    this.freshIdentity = freshIdentity;
  }
}

/**
 * Re-check the exact workspace, user, effective role, and viewer-mode state
 * immediately before an admin mutation. The server remains authoritative;
 * this closes the stale-tab window where a control was opened before a role or
 * workspace switch and would otherwise submit under different authority.
 */
export async function verifyFreshAdminAuthority(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  const openedRole = effectiveAuthRole(opened);
  const freshRole = effectiveAuthRole(fresh);
  if (
    fresh.user_id !== opened.user_id ||
    fresh.tenant_id !== opened.tenant_id ||
    freshRole !== openedRole ||
    Boolean(fresh.viewer_mode) !== Boolean(opened.viewer_mode)
  ) {
    throw new FreshAdminAuthorityError(
      "changed",
      "Workspace identity or authority changed. Nothing was written; reload and retry.",
      fresh,
    );
  }
  if (fresh.viewer_mode || !roleCanWrite(freshRole)) {
    throw new FreshAdminAuthorityError(
      "forbidden",
      "Owner or admin access is required.",
      fresh,
    );
  }
  return fresh;
}
