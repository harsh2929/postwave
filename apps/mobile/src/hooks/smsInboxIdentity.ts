/**
 * smsInboxIdentity — WHICH identity an SMS request belongs to, and whether it
 * is still the current one.
 *
 * Split out of `@/hooks/useSmsInbox` because that file was carrying two
 * concerns and had outgrown this app's source budget. Deliberately NOT a hook
 * module: nothing here touches react, so the identity rules can be reasoned
 * about (and called from a query function) without a render. `useSmsInbox`
 * keeps `useSmsInboxAccess`, which is the react half — and which must stay
 * beside the queries it gates, because the online-gating guard test
 * (`src/hooks/online-query-gating.test.ts`) checks that every file issuing a
 * TanStack query names `useOnlineQueryGate` itself.
 *
 * WHY A FINGERPRINT AND NOT A TENANT ID. Five things can change what an
 * operator is allowed to read — base URL, tenant, user, effective role, and
 * the context epoch the app bumps when the server says the session's meaning
 * changed. Any one of them must retire the cache, so all five are hashed into
 * one string that a query key can carry as its second element.
 *
 * WHY `assertCurrentSmsIdentity` RE-READS THE STORE. A request started under
 * one identity can land after the identity changed. Checking the LIVE store at
 * response time, not the captured props, is what stops a late response being
 * written into the next identity's cache.
 */
import { readContextEpoch } from "@/lib/contextEpoch";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore, type AuthMode } from "@/store/auth";

export interface SmsInboxIdentity {
  baseUrl: string;
  tenantId: string;
  userId: string;
  effectiveRole: string;
  mode: "session";
  contextEpoch: string | null;
  fingerprint: string;
}

export interface SmsInboxAccess {
  identity: SmsInboxIdentity | null;
  roleAllowed: boolean;
  canRequest: boolean;
  online: boolean;
  sessionReady: boolean;
  denialReason: string | null;
}

export function makeIdentity(input: {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
  mode: AuthMode | null;
  contextEpoch: string | null;
}): SmsInboxIdentity | null {
  if (
    input.mode !== "session" ||
    !input.baseUrl ||
    !input.tenantId ||
    !input.userId ||
    !input.effectiveRole
  ) {
    return null;
  }
  const fingerprint = JSON.stringify([
    input.baseUrl,
    input.tenantId,
    input.userId,
    input.effectiveRole,
    input.mode,
    input.contextEpoch,
  ]);
  return {
    baseUrl: input.baseUrl,
    tenantId: input.tenantId,
    userId: input.userId,
    effectiveRole: input.effectiveRole,
    mode: "session",
    contextEpoch: input.contextEpoch,
    fingerprint,
  };
}

export class SmsIdentityRetiredError extends Error {
  constructor() {
    super("Your workspace or access changed. Refresh before trying again.");
    this.name = "SmsIdentityRetiredError";
  }
}

export function assertCurrentSmsIdentity(expected: SmsInboxIdentity): void {
  const state = useAuthStore.getState();
  const current = makeIdentity({
    baseUrl: state.baseUrl,
    tenantId: state.tenantId ?? state.session?.tenantId ?? null,
    userId: state.session?.userId ?? null,
    effectiveRole: state.session?.effectiveRole ?? null,
    mode: state.mode,
    contextEpoch: readContextEpoch() ?? null,
  });
  const epochMatches = current?.contextEpoch === expected.contextEpoch;
  if (
    !current ||
    !state.canUseOnlineServices() ||
    !canAccessMinimumRole("admin", current.effectiveRole, current.mode) ||
    current.baseUrl !== expected.baseUrl ||
    current.tenantId !== expected.tenantId ||
    current.userId !== expected.userId ||
    current.effectiveRole !== expected.effectiveRole ||
    !epochMatches
  ) {
    throw new SmsIdentityRetiredError();
  }
}

export function identityOrThrow(
  canRequest: boolean,
  identity: SmsInboxIdentity | null,
): SmsInboxIdentity {
  if (!canRequest || !identity) throw new SmsIdentityRetiredError();
  assertCurrentSmsIdentity(identity);
  return identity;
}
