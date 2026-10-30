// SPDX-License-Identifier: AGPL-3.0-only

import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  assertFreshCampaignWriteAuthority,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";

/**
 * Flow authoring is protected by the backend's write:campaigns scope. Keep the
 * web presentation gate on exactly the same owner/admin/editor, non-viewer-mode
 * authority rule instead of inventing a second role matrix for flows.
 */
export const canWriteFlows = canWriteCampaigns;

export const FLOW_READ_ONLY_MESSAGE =
  "Flows are read-only for this session. Owner, admin, or editor access outside viewer mode is required to create, rename, duplicate, archive, validate, or change stored flow configuration.";

export class FlowWriteAuthorityError extends Error {
  readonly code = "flow_write_authority_changed";

  constructor() {
    super(
      "Your flow write authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "FlowWriteAuthorityError";
  }
}

/**
 * Re-read the cookie-backed identity immediately before a Flow write and bind
 * it to the exact tenant, user, effective role, and viewer-mode-safe authority
 * that rendered the control. The server remains the final authorization gate.
 */
export async function verifyFreshFlowWriteAuthority(
  opened: MeResponse | null | undefined,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  try {
    assertFreshCampaignWriteAuthority(opened, fresh);
  } catch {
    throw new FlowWriteAuthorityError();
  }
  return fresh;
}
