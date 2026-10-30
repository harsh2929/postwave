// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";

/**
 * Identity stamp for private, principal-scoped browser state.
 *
 * Tenant alone is not enough: two users can share a browser and workspace,
 * and viewer mode changes what the same underlying role may see or do. The
 * held role is retained alongside the effective role so an authority change
 * while viewer mode is active still invalidates the scope.
 */
export function exactPrincipalKey(
  identity: MeResponse | null | undefined,
): string {
  if (!identity) return "unverified";
  return [
    identity.tenant_id,
    identity.user_id,
    identity.role,
    effectiveAuthRole(identity),
    identity.viewer_mode === true ? "viewer-mode" : "member-mode",
  ].join("\u001f");
}

export function sameExactPrincipal(
  opened: MeResponse,
  candidate: MeResponse,
): boolean {
  return exactPrincipalKey(opened) === exactPrincipalKey(candidate);
}

export class FreshPrincipalChangedError extends Error {
  readonly freshIdentity: MeResponse;

  constructor(freshIdentity: MeResponse) {
    super(
      "Workspace identity or authority changed. Nothing was completed; reload and retry.",
    );
    this.name = "FreshPrincipalChangedError";
    this.freshIdentity = freshIdentity;
  }
}

/**
 * Re-resolve the exact user/workspace/authority snapshot immediately before a
 * principal-sensitive action. This deliberately does not require an admin
 * role: signing out the user's own sessions, revoking an MFA bypass, and
 * managing their login methods must remain available in viewer mode.
 */
export async function verifyFreshExactPrincipal(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  if (!sameExactPrincipal(opened, fresh)) {
    throw new FreshPrincipalChangedError(fresh);
  }
  return fresh;
}
