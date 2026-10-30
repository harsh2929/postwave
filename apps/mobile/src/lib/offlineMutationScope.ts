/**
 * lib/offlineMutationScope.ts — the identity guard every queued write shares.
 *
 * Split out of lib/offlineMutations.ts so the generic entity-write executor
 * (lib/offlineEntityWrite.ts, NATIVE#1) enforces the SAME rules as the three
 * original hand-written mutations without importing them (which would make the
 * registration edge circular).
 *
 * What this guards, and why each rule exists:
 *
 *   - TTL. A queued write is a promise about the world made two hours ago at
 *     the latest. Past that the user's mental model has moved on and replaying
 *     silently is worse than asking again.
 *   - IDENTITY. baseUrl + tenant + principal + effective ROLE must all still
 *     match. Role is included deliberately: an edit authored as an admin must
 *     not replay after the same person's grant was reduced.
 *   - OPERATION ID. Doubles as the API Idempotency-Key, so replay after a
 *     process kill cannot duplicate a server-side write.
 */
import { getClient } from "@/api/sdkClient";
import { useAuthStore } from "@/store/auth";

import { isStaleContext, STALE_CONTEXT_MESSAGE } from "@postwave/offline-outbox";

import { readContextEpoch } from "./contextEpoch";
import type { OfflineMutationAuthScope } from "./offlineMutationContract";

export const OFFLINE_MUTATION_TTL_MS = 2 * 60 * 60 * 1000;

export class OfflineMutationReplayError extends Error {
  constructor(
    readonly code:
      | "missing_scope"
      | "expired"
      | "identity_mismatch"
      | "not_queueable"
      // The record this write targets was deleted after it was queued.
      // Distinct from the others: nothing went wrong and there is nothing to
      // retry, so a surface should say the record is gone rather than offer a
      // "try again" that would recreate it.
      | "target_deleted"
      // The caller's role, plan or workspace moved while this write waited.
      // Distinct from identity_mismatch, which compares facts the CLIENT
      // holds: this is the server's own verdict, and it catches changes the
      // device cannot derive — a plan downgrade, or a role change that has
      // not yet reached this device's auth store.
      | "context_changed",
    message: string,
  ) {
    super(message);
    this.name = "OfflineMutationReplayError";
  }
}

/**
 * Non-secret, process-stable fingerprint of an API key. Never persist the key
 * itself; this exists only to isolate in-memory queued work across credential
 * switches.
 */
export function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function currentOfflineAuthScope(): OfflineMutationAuthScope {
  const { baseUrl, tenantId } = getClient();
  const auth = useAuthStore.getState();
  const now = Date.now();
  const epoch = readContextEpoch();
  if (auth.mode === "session" && auth.session) {
    return {
      baseUrl,
      tenantId,
      principalId: auth.session.userId,
      role: auth.session.effectiveRole,
      queuedAt: now,
      expiresAt: now + OFFLINE_MUTATION_TTL_MS,
      // The server's own answer to "which context is this?", recorded here
      // because this is the ONE function every screen calls to build a scope.
      ...(epoch ? { contextEpoch: epoch } : {}),
    };
  }
  if (auth.mode === "api_key" && auth.apiKey) {
    return {
      baseUrl,
      tenantId,
      principalId: `api-key:${fingerprint(auth.apiKey)}`,
      role: "api_key",
      queuedAt: now,
      expiresAt: now + OFFLINE_MUTATION_TTL_MS,
      ...(epoch ? { contextEpoch: epoch } : {}),
    };
  }
  throw new Error("Offline edits require a complete authenticated identity.");
}

export function assertOperationId(
  operationId: string | undefined,
): asserts operationId is string {
  if (
    typeof operationId !== "string" ||
    operationId.length < 16 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(operationId)
  ) {
    throw new OfflineMutationReplayError(
      "missing_scope",
      "Offline edit cannot replay because its operation identity is invalid.",
    );
  }
}

export function assertCurrentAuthScope(
  auth: OfflineMutationAuthScope | undefined,
) {
  const ctx = getClient();
  const current = useAuthStore.getState();
  if (!auth) {
    throw new OfflineMutationReplayError(
      "missing_scope",
      "Offline edit cannot replay because it has no auth scope.",
    );
  }
  if (
    !Number.isFinite(auth.queuedAt) ||
    !Number.isFinite(auth.expiresAt) ||
    auth.queuedAt > Date.now() + 60_000 ||
    auth.expiresAt <= Date.now() ||
    auth.expiresAt - auth.queuedAt > OFFLINE_MUTATION_TTL_MS
  ) {
    throw new OfflineMutationReplayError(
      "expired",
      "Offline edit expired before it could sync. Review and submit it again.",
    );
  }
  const currentPrincipal =
    current.mode === "session" && current.session
      ? {
          principalId: current.session.userId,
          role: current.session.effectiveRole,
        }
      : current.mode === "api_key" && current.apiKey
        ? {
            principalId: `api-key:${fingerprint(current.apiKey)}`,
            role: "api_key",
          }
        : null;
  if (
    !currentPrincipal ||
    auth.baseUrl !== ctx.baseUrl ||
    auth.tenantId !== ctx.tenantId ||
    auth.principalId !== currentPrincipal.principalId ||
    auth.role !== currentPrincipal.role
  ) {
    throw new OfflineMutationReplayError(
      "identity_mismatch",
      "Offline edit belongs to a different user, role, or workspace. Sign back into that exact identity to replay it.",
    );
  }
  // The server's verdict, after the client-side comparison above.
  //
  // Checked SECOND on purpose: identity_mismatch is the more specific and more
  // actionable answer ("sign back in as that person"), so a write that fails
  // both should say that rather than the vaguer context message.
  if (isStaleContext(auth, readContextEpoch())) {
    throw new OfflineMutationReplayError("context_changed", STALE_CONTEXT_MESSAGE);
  }
  return ctx;
}
