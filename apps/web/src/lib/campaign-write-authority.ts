// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

const CAMPAIGN_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];
const CAMPAIGN_ADMIN_ROLES: readonly AuthRole[] = ["owner", "admin"];

export const CAMPAIGN_READ_ONLY_MESSAGE =
  "Campaign changes are read-only for this session. Owner, admin, or editor access outside viewer mode is required to create, duplicate, change, delete, or send a campaign.";

export class CampaignWriteAuthorityError extends Error {
  readonly code = "campaign_write_authority_changed";

  constructor() {
    super(
      "Your campaign write authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "CampaignWriteAuthorityError";
  }
}

export class CampaignAdminAuthorityError extends Error {
  readonly code = "campaign_admin_authority_changed";

  constructor() {
    super(
      "Your campaign admin authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "CampaignAdminAuthorityError";
  }
}

export function canWriteCampaigns(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    CAMPAIGN_WRITE_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function canAdminCampaigns(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    CAMPAIGN_ADMIN_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function assertFreshCampaignWriteAuthority(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
): void {
  if (
    !opened ||
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    !canWriteCampaigns(opened) ||
    !canWriteCampaigns(fresh)
  ) {
    throw new CampaignWriteAuthorityError();
  }
}

/**
 * Re-read authority through the online-only auth boundary and compare it with
 * the identity that rendered the action. Keeping this in one helper makes it
 * difficult for nested campaign controls to accidentally treat a fresh role
 * from a different user or workspace as authorization.
 */
export async function confirmFreshCampaignWriteAuthority(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  assertFreshCampaignWriteAuthority(opened, await whoamiFresh(signal));
}

export function assertFreshCampaignAdminAuthority(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
): void {
  if (
    !opened ||
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    !canAdminCampaigns(opened) ||
    !canAdminCampaigns(fresh)
  ) {
    throw new CampaignAdminAuthorityError();
  }
}

export async function confirmFreshCampaignAdminAuthority(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  assertFreshCampaignAdminAuthority(opened, await whoamiFresh(signal));
}
