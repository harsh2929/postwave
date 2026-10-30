/**
 * hooks/useHelpdeskIdentity.ts — who is asking, and whether they still are.
 *
 * Helpdesk holds another workspace's private customer correspondence, so every
 * cached row and every in-flight mutation is bound to a FINGERPRINT of the
 * exact principal that requested it (base URL, tenant, user, effective role,
 * mode, context epoch). When that fingerprint changes — reauthorization, a
 * tenant switch, a role downgrade, going offline — the retired identity's
 * queries and mutations are cancelled and REMOVED rather than left to answer
 * the next viewer from cache.
 *
 * Split out of `useHelpdesk` for size. The queries and mutations there call
 * `identityOrThrow` before every request and `assertCurrentHelpdeskIdentity`
 * after every response, so a response that arrives after the principal changed
 * is discarded instead of rendered.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { normalizeApiBaseUrl } from "@/api/url";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { onContextEpochChange, readContextEpoch } from "@/lib/contextEpoch";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { normalizeHelpdeskId } from "@/lib/helpdesk";
import { useAuthStore, type AuthMode } from "@/store/auth";

export const HELPDESK_QUEUE_KEY = "helpdesk-conversations-v2";
export const HELPDESK_THREAD_KEY = "helpdesk-thread-v2";
export const HELPDESK_CONVERSATION_KEY = "helpdesk-conversation-v2";
export const HELPDESK_CATALOG_KEY = "helpdesk-catalog-v2";
const HELPDESK_QUERY_ROOTS = new Set([
  HELPDESK_QUEUE_KEY,
  HELPDESK_THREAD_KEY,
  HELPDESK_CONVERSATION_KEY,
  HELPDESK_CATALOG_KEY,
]);
const HELPDESK_MUTATION_ROOTS = new Set([
  "helpdesk-internal-note-v2",
  "helpdesk-status-v2",
  "helpdesk-assignment-v2",
]);

export interface HelpdeskIdentity {
  baseUrl: string;
  tenantId: string;
  userId: string;
  effectiveRole: string;
  mode: "session";
  contextEpoch: string;
  fingerprint: string;
  noteRecoveryPrincipal: string;
}

export interface HelpdeskAccess {
  identity: HelpdeskIdentity | null;
  onlineGate: { readonly enabled: boolean };
  roleAllowed: boolean;
  sessionReady: boolean;
  online: boolean;
  canRequest: boolean;
  denialReason: string | null;
}

export function helpdeskIdentityKey(identity: HelpdeskIdentity | null) {
  return [
    identity?.fingerprint ?? null,
    identity?.baseUrl ?? null,
    identity?.tenantId ?? null,
    identity?.userId ?? null,
    identity?.effectiveRole ?? null,
    identity?.mode ?? null,
    identity?.contextEpoch ?? null,
  ] as const;
}

export function makeHelpdeskIdentity(input: {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
  mode: AuthMode | null;
  contextEpoch: string | null;
}): HelpdeskIdentity | null {
  if (
    input.mode !== "session" ||
    !input.baseUrl ||
    !input.tenantId ||
    !input.userId ||
    !input.effectiveRole ||
    !input.contextEpoch
  ) {
    return null;
  }
  const tenantId = normalizeHelpdeskId(input.tenantId);
  const userId = normalizeHelpdeskId(input.userId);
  const effectiveRole = input.effectiveRole.trim().toLowerCase();
  const contextEpoch = input.contextEpoch.trim();
  let baseUrl: string;
  try {
    baseUrl = normalizeApiBaseUrl(input.baseUrl);
  } catch {
    return null;
  }
  if (
    !tenantId ||
    !userId ||
    !baseUrl ||
    !contextEpoch ||
    contextEpoch.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
      contextEpoch,
    )
  ) {
    return null;
  }
  // The durable note ledger belongs to the canonical human session principal,
  // not to volatile role/context authorization state. Keep the request cache
  // fingerprint epoch-bound below, while this domain-separated principal stays
  // stable across legitimate reauthorization and viewer-mode transitions.
  const noteRecoveryPrincipal = JSON.stringify([
    "postwave.mobile.helpdesk-note-recovery.v2",
    "session-user",
    baseUrl,
    tenantId,
    userId,
  ]);
  const fingerprint = JSON.stringify([
    "postwave.mobile.helpdesk-request.v2",
    baseUrl,
    tenantId,
    userId,
    effectiveRole,
    input.mode,
    contextEpoch,
  ]);
  return {
    baseUrl,
    tenantId,
    userId,
    effectiveRole,
    mode: "session",
    contextEpoch,
    fingerprint,
    noteRecoveryPrincipal,
  };
}

export function useHelpdeskAccess(focused = true): HelpdeskAccess {
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const mode = useAuthStore((state) => state.mode);
  const storeBaseUrl = useAuthStore((state) => state.baseUrl);
  const storeUserId = useAuthStore((state) => state.session?.userId ?? null);
  const client = useQueryClient();
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  useEffect(() => onContextEpochChange((epoch) => setContextEpoch(epoch)), []);
  const roleAllowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const identity = useMemo(
    () =>
      makeHelpdeskIdentity({
        baseUrl: gate.baseUrl ?? storeBaseUrl,
        tenantId: gate.tenantId,
        userId: gate.userId ?? storeUserId,
        effectiveRole: gate.effectiveRole,
        mode,
        contextEpoch,
      }),
    [
      contextEpoch,
      gate.baseUrl,
      gate.effectiveRole,
      gate.tenantId,
      gate.userId,
      mode,
      storeBaseUrl,
      storeUserId,
    ],
  );
  const sessionReady = gate.enabled && Boolean(identity);
  const canRequest = focused && online && sessionReady && roleAllowed;
  const fingerprint = identity?.fingerprint ?? null;

  useEffect(() => {
    const helpdeskQuery = (query: { queryKey: readonly unknown[] }) =>
      HELPDESK_QUERY_ROOTS.has(String(query.queryKey[0]));
    const retired = (query: { queryKey: readonly unknown[] }) =>
      helpdeskQuery(query) && query.queryKey[1] !== fingerprint;
    const mutationCache = client.getMutationCache();
    const helpdeskMutation = (mutation: {
      options: { mutationKey?: readonly unknown[] };
    }) =>
      HELPDESK_MUTATION_ROOTS.has(String(mutation.options.mutationKey?.[0]));
    const retiredMutation = (mutation: {
      options: { mutationKey?: readonly unknown[] };
    }) =>
      helpdeskMutation(mutation) &&
      mutation.options.mutationKey?.[1] !== fingerprint;
    const removeMutations = (
      predicate: (mutation: {
        options: { mutationKey?: readonly unknown[] };
      }) => boolean,
    ) => {
      for (const mutation of mutationCache.getAll()) {
        if (predicate(mutation)) mutationCache.remove(mutation);
      }
    };
    const protectedDataAllowed =
      roleAllowed && Boolean(identity) && sessionReady && online;
    if (!protectedDataAllowed) {
      void client.cancelQueries({ predicate: helpdeskQuery });
      client.removeQueries({ predicate: helpdeskQuery });
      removeMutations(helpdeskMutation);
    } else {
      void client.cancelQueries({ predicate: retired });
      client.removeQueries({ predicate: retired });
      removeMutations(retiredMutation);
      if (!canRequest) {
        void client.cancelQueries({ predicate: helpdeskQuery });
        removeMutations(helpdeskMutation);
      }
    }
  }, [
    canRequest,
    client,
    fingerprint,
    identity,
    online,
    roleAllowed,
    sessionReady,
  ]);

  return {
    identity,
    onlineGate: { enabled: gate.enabled },
    roleAllowed,
    sessionReady,
    online,
    canRequest,
    denialReason: roleAllowed
      ? null
      : mode === "api_key"
        ? "Helpdesk requires an owner or admin workspace session; mobile cannot verify API-key scopes."
        : "Helpdesk records are restricted to workspace owners and admins.",
  };
}

export class HelpdeskIdentityRetiredError extends Error {
  readonly status = 403;
  readonly code = "helpdesk_identity_retired";

  constructor() {
    super(
      "Your workspace or Helpdesk access changed. Refresh before trying again.",
    );
    this.name = "HelpdeskIdentityRetiredError";
  }
}

export function assertCurrentHelpdeskIdentity(
  expected: HelpdeskIdentity,
): void {
  const state = useAuthStore.getState();
  const current = makeHelpdeskIdentity({
    baseUrl: state.baseUrl,
    tenantId: state.tenantId ?? state.session?.tenantId ?? null,
    userId: state.session?.userId ?? null,
    effectiveRole: state.session?.effectiveRole ?? null,
    mode: state.mode,
    contextEpoch: readContextEpoch() ?? null,
  });
  if (
    !current ||
    !state.canUseOnlineServices() ||
    !canAccessMinimumRole("admin", current.effectiveRole, current.mode) ||
    current.fingerprint !== expected.fingerprint
  ) {
    throw new HelpdeskIdentityRetiredError();
  }
}

export async function reauthorizeHelpdeskIdentity(
  expected: HelpdeskIdentity,
): Promise<void> {
  assertCurrentHelpdeskIdentity(expected);
  const before = useAuthStore.getState();
  if (before.mode !== "session") throw new HelpdeskIdentityRetiredError();
  const profile = await before.refreshSessionFromServer();
  if (
    profile.tenantId.toLowerCase() !== expected.tenantId ||
    profile.userId.toLowerCase() !== expected.userId ||
    !canAccessMinimumRole("admin", profile.effectiveRole, "session")
  ) {
    throw new HelpdeskIdentityRetiredError();
  }
  assertCurrentHelpdeskIdentity(expected);
}

export function identityOrThrow(access: HelpdeskAccess): HelpdeskIdentity {
  if (!access.canRequest || !access.identity) {
    throw new HelpdeskIdentityRetiredError();
  }
  assertCurrentHelpdeskIdentity(access.identity);
  return access.identity;
}
