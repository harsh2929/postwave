// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthRole, MeResponse } from "@/lib/auth-api";

export const RETENTION_OFFERS_ROUTE = "/app/retention" as const;

type RetentionIdentity = Pick<
  MeResponse,
  "role" | "effective_role" | "viewer_mode"
>;

export function retentionEffectiveRole(
  identity: RetentionIdentity | null | undefined,
): AuthRole | null {
  return identity ? (identity.effective_role ?? identity.role) : null;
}

/** Match the API's intended exact owner/admin boundary and honour viewer mode. */
export function canAccessRetentionOffers(
  identity: RetentionIdentity | null | undefined,
): boolean {
  const role = retentionEffectiveRole(identity);
  return (
    identity?.viewer_mode !== true && (role === "owner" || role === "admin")
  );
}

export function isRetentionOffersRoute(href: string): boolean {
  return (
    href === RETENTION_OFFERS_ROUTE ||
    href.startsWith(`${RETENTION_OFFERS_ROUTE}/`)
  );
}
