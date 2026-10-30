// SPDX-License-Identifier: AGPL-3.0-only

import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";

export const SERVICE_SUITE_QUERY_ROOT = "service-suite-v2";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UNSAFE_CONTEXT_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export interface ServiceSuiteIdentity {
  origin: string;
  tenantId: string;
  userId: string;
  effectiveRole: "owner" | "admin";
  contextEpoch: string;
  fingerprint: string;
  queryBase: readonly unknown[];
}

export function serviceSuiteIdentity(input: {
  me: MeResponse | null;
  origin: string;
  contextEpoch: string | null;
}): ServiceSuiteIdentity | null {
  if (
    !input.me ||
    input.me.viewer_mode ||
    !input.origin ||
    !input.contextEpoch
  ) {
    return null;
  }
  const effectiveRole = effectiveAuthRole(input.me);
  // `whoami` is an authority response, not user-entered routing input. Reject
  // non-canonical wire identities instead of silently changing their scope.
  const tenantId = input.me.tenant_id;
  const userId = input.me.user_id;
  const contextEpoch = input.contextEpoch.trim();
  let origin: string;
  try {
    const parsed = new URL(input.origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  if (
    (effectiveRole !== "owner" && effectiveRole !== "admin") ||
    !UUID_RE.test(tenantId) ||
    !UUID_RE.test(userId) ||
    !contextEpoch ||
    contextEpoch.length > 512 ||
    UNSAFE_CONTEXT_RE.test(contextEpoch)
  ) {
    return null;
  }
  const fingerprint = JSON.stringify([
    origin,
    tenantId,
    userId,
    effectiveRole,
    contextEpoch,
  ]);
  return {
    origin,
    tenantId,
    userId,
    effectiveRole,
    contextEpoch,
    fingerprint,
    queryBase: [
      SERVICE_SUITE_QUERY_ROOT,
      fingerprint,
      origin,
      tenantId,
      userId,
      effectiveRole,
      contextEpoch,
    ],
  };
}
