// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

const LANDING_PAGE_ADMIN_ROLES: readonly AuthRole[] = ["owner", "admin"];

/**
 * Canonical landing-page writes are mounted behind ScopeAdmin. Editors and
 * viewers keep the campaign-read surfaces, but must never be offered a write.
 */
export const LANDING_PAGE_ADMIN_ONLY_MESSAGE =
  "Landing pages are read-only for this session. Owner or admin access outside viewer mode is required to create, duplicate, edit, publish, restore, or archive a page.";

export class LandingPageAuthorityError extends Error {
  readonly code = "landing_page_admin_authority_changed";

  constructor() {
    super(
      "Your landing-page admin authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "LandingPageAuthorityError";
  }
}

export function canAdminLandingPages(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    LANDING_PAGE_ADMIN_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function assertFreshLandingPageAdminAuthority(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
): void {
  if (
    !opened ||
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    Boolean(opened.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    !canAdminLandingPages(opened) ||
    !canAdminLandingPages(fresh)
  ) {
    throw new LandingPageAuthorityError();
  }
}

export async function confirmFreshLandingPageAdminAuthority(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  assertFreshLandingPageAdminAuthority(opened, await whoamiFresh(signal));
}
