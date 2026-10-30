// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

const OUTBOUND_WEBHOOK_ADMIN_ROLES: readonly AuthRole[] = ["owner", "admin"];

export const OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE =
  "Workspace admin access is required to view or manage outbound destinations. This surface does not expose a partial read-only mode.";

export class OutboundWebhookAuthorityError extends Error {
  readonly code = "outbound_webhook_admin_authority_changed";

  constructor() {
    super(
      "Your outbound-webhook admin authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "OutboundWebhookAuthorityError";
  }
}

export function canAdminOutboundWebhooks(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    OUTBOUND_WEBHOOK_ADMIN_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function assertFreshOutboundWebhookAdmin(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
): void {
  if (
    !opened ||
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    Boolean(opened.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    !canAdminOutboundWebhooks(opened) ||
    !canAdminOutboundWebhooks(fresh)
  ) {
    throw new OutboundWebhookAuthorityError();
  }
}

export async function confirmFreshOutboundWebhookAdmin(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  assertFreshOutboundWebhookAdmin(opened, await whoamiFresh(signal));
}
