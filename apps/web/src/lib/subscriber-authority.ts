// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

export interface SubscriberAuthority {
  tenantId: string;
  userId: string;
  role: Exclude<AuthRole, "viewer">;
}

export class SubscriberAuthorityError extends Error {
  readonly code = "subscriber_authority_changed";

  constructor(
    message = "Workspace access changed. Refresh before continuing.",
  ) {
    super(message);
    this.name = "SubscriberAuthorityError";
  }
}

export function subscriberAuthorityFromMe(
  me: MeResponse,
): SubscriberAuthority | null {
  const role = effectiveAuthRole(me);
  if (me.viewer_mode === true || role === "viewer") return null;
  return {
    tenantId: me.tenant_id,
    userId: me.user_id,
    role,
  };
}

export function sameSubscriberAuthority(
  expected: SubscriberAuthority,
  current: MeResponse,
): boolean {
  const actual = subscriberAuthorityFromMe(current);
  return Boolean(
    actual &&
    actual.tenantId === expected.tenantId &&
    actual.userId === expected.userId &&
    actual.role === expected.role,
  );
}

/**
 * Re-read the HttpOnly-cookie session immediately around a write. Query-cache
 * role gating is presentation only; this binds the action to the exact tenant,
 * user, effective role, and viewer-mode state the operator began with.
 */
export async function reauthorizeSubscriberMutation(
  expected: SubscriberAuthority,
  signal?: AbortSignal,
): Promise<void> {
  const current = await whoamiFresh(signal);
  if (!sameSubscriberAuthority(expected, current)) {
    throw new SubscriberAuthorityError();
  }
}
