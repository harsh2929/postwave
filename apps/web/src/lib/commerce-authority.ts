// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Who may change commerce configuration on web.
 *
 * Every commerce write route is mounted behind `apikeys.ScopeAdmin`
 * (create catalog, import products, create feed, Shopify OAuth start), and the
 * reads behind `ScopeReadReports`. The page withholds the admin verbs from
 * anyone else and says why, so a viewer never meets a 403 by pressing a
 * button the server was always going to refuse.
 */

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";
import { sameExactPrincipal } from "@/lib/exact-principal";

const COMMERCE_ADMIN_ROLES: readonly AuthRole[] = ["owner", "admin"];

export const COMMERCE_ADMIN_ONLY_MESSAGE =
  "You have view-only access to commerce. An owner or admin outside viewer mode can connect stores, create catalogs, import products, and create feeds.";

export function canAdminCommerce(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    COMMERCE_ADMIN_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export class CommerceAuthorityError extends Error {
  readonly code = "commerce_admin_authority_changed";

  constructor() {
    super(
      "Your commerce administration authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "CommerceAuthorityError";
  }
}

export function assertFreshCommerceAdmin(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
): void {
  if (
    !opened ||
    !sameExactPrincipal(opened, fresh) ||
    !canAdminCommerce(opened) ||
    !canAdminCommerce(fresh)
  ) {
    throw new CommerceAuthorityError();
  }
}

export async function confirmFreshCommerceAdmin(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  assertFreshCommerceAdmin(opened, await whoamiFresh(signal));
}
