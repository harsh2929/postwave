import {
  enqueueOfflineMutation,
  getOfflineIdentity,
  isOfflineCacheableGet,
  isQueueableMutation,
  readCachedResponse,
} from "./offline-store";
import { getOnlineStatus } from "./online-manager";
import { vaultGetJSON } from "./secure-vault";
import { sensitiveVaultCacheKey } from "./sensitive-vault-cache-key";
import {
  apiIdentityGenerationIsCurrent,
  apiIdentityTransitionError,
} from "./api-identity-transition";
import { queuedResult, type QueueableApiResult } from "./api/result";

interface OfflineRequestContext {
  path: string;
  method: string;
  body: unknown;
  headers: HeadersInit | undefined;
  idempotencyKey: string | undefined;
  requireOnline: boolean;
  identityGeneration: number;
  kickOutbox: () => void;
}

export function requestIsOffline(): boolean {
  const browserOffline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  return browserOffline || getOnlineStatus() === "offline";
}

export function isSensitiveVaultGet(path: string): boolean {
  return (
    /^\/api\/v1\/subscribers\/[^/?]+$/.test(path) ||
    /^\/api\/v1\/audit(?:\?|$)/.test(path) ||
    /^\/api\/v1\/suppressions(?:\?|$)/.test(path)
  );
}

export async function resolveOfflineRequest<T>({
  path,
  method,
  body,
  headers,
  idempotencyKey,
  requireOnline,
  identityGeneration,
  kickOutbox,
}: OfflineRequestContext): Promise<QueueableApiResult<T>> {
  if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
    return apiIdentityTransitionError("identity_changed", body);
  }
  if (method === "GET" && isOfflineCacheableGet(path)) {
    const cached = readCachedResponse<T>(path);
    if (cached !== null) return { data: cached };
  }
  if (method === "GET" && isSensitiveVaultGet(path)) {
    const vaultKey = await sensitiveVaultCacheKey(getOfflineIdentity(), path);
    if (vaultKey) {
      try {
        const cached = await vaultGetJSON<T>(vaultKey);
        if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
          return apiIdentityTransitionError("identity_changed", body);
        }
        if (cached !== null) return { data: cached };
      } catch {
        /* encrypted vault unavailable */
      }
    }
  }
  if (!requireOnline && isQueueableMutation(method, path, body)) {
    if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
      return apiIdentityTransitionError("identity_changed", body);
    }
    const admission = await enqueueOfflineMutation({
      method,
      path,
      body,
      headers,
      idempotencyKey,
    });
    if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
      return apiIdentityTransitionError("identity_changed", body);
    }
    if (admission.ok) {
      kickOutbox();
      return queuedResult(admission.receipt);
    }
    return {
      error: {
        kind: "network",
        code: `offline_queue_${admission.code.replaceAll("-", "_")}`,
        message: admission.message,
      },
      retryability:
        admission.code === "policy-refused" ? "after-reconnect" : "manual",
      preservedDraft: admission.preservedDraft,
    };
  }
  return {
    error: {
      kind: "network",
      code: "offline",
      message:
        "You appear to be offline. This action requires a live connection.",
    },
    retryability: "after-reconnect",
    ...(body === undefined ? {} : { preservedDraft: body }),
  };
}
