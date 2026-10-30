import { useMemo } from "react";
import { randomUUID } from "expo-crypto";

import { normalizeApiBaseUrl } from "@/api/url";
import { useAuthStore, type AuthSnapshot } from "@/store/auth";

type OnlineQueryAuthState = Pick<
  AuthSnapshot,
  "apiKey" | "baseUrl" | "mode" | "tenantId" | "session"
> & {
  canUseOnlineServices: () => boolean;
};

export type OnlineQueryGate = {
  enabled: boolean;
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
  /** Non-secret identity for the active credential generation. */
  credentialScope: string;
  canReadOfflineSnapshots: boolean;
};

export function onlineQueryAuthorityOwner(
  gate: Pick<
    OnlineQueryGate,
    "baseUrl" | "tenantId" | "userId" | "effectiveRole" | "credentialScope"
  >,
): string {
  let baseUrl = gate.baseUrl?.trim() ?? "";
  if (baseUrl) {
    try {
      baseUrl = normalizeApiBaseUrl(baseUrl);
    } catch {
      baseUrl = `invalid:${baseUrl}`;
    }
  }
  return JSON.stringify([
    baseUrl || "origin-unresolved",
    gate.tenantId ?? "tenant-unresolved",
    gate.userId ?? "user-anonymous",
    gate.effectiveRole ?? "role-unresolved",
    gate.credentialScope,
  ]);
}

/**
 * Network reads and offline snapshot reads have different authority needs.
 * In particular, an API-key principal has no human user/role snapshot scope,
 * but must still be allowed to fetch its live workspace settings.
 */
export function canRunOnlineOrSnapshotQuery(
  gate: Pick<OnlineQueryGate, "enabled" | "canReadOfflineSnapshots">,
): boolean {
  return gate.enabled || gate.canReadOfflineSnapshots;
}

let activeApiKey: string | null = null;
let activeApiKeyGeneration: string | null = null;

/**
 * Stable, non-secret, collision-resistant generation for the active API-key
 * credential. The raw bearer is never placed in React keys, query keys, logs,
 * or snapshots. A new cryptographic UUID is minted whenever the credential
 * changes; unlike a short deterministic hash, a chosen key cannot collide with
 * another generation and inherit its draft or query state.
 */
export function apiKeyLifecycleFingerprint(apiKey: string): string {
  if (activeApiKey !== apiKey || !activeApiKeyGeneration) {
    activeApiKey = apiKey;
    activeApiKeyGeneration = randomUUID();
  }
  return activeApiKeyGeneration;
}

function credentialScope(
  mode: AuthSnapshot["mode"],
  apiKey: string | null,
): string {
  if (mode === "api_key") {
    return apiKey
      ? `api-key:${apiKeyLifecycleFingerprint(apiKey)}`
      : "api-key:missing";
  }
  activeApiKey = null;
  activeApiKeyGeneration = null;
  return mode === "session" ? "session" : "none";
}

export function selectOnlineQueryGate(
  state: OnlineQueryAuthState,
): OnlineQueryGate {
  const tenantId = state.tenantId ?? state.session?.tenantId ?? null;
  const userId =
    state.mode === "session" ? (state.session?.userId ?? null) : null;
  const effectiveRole =
    state.mode === "session" ? (state.session?.effectiveRole ?? null) : null;
  return {
    enabled: state.canUseOnlineServices(),
    baseUrl: state.baseUrl,
    tenantId,
    userId,
    effectiveRole,
    credentialScope: credentialScope(state.mode, state.apiKey),
    canReadOfflineSnapshots: Boolean(
      state.mode === "session" &&
      state.baseUrl &&
      tenantId &&
      userId &&
      effectiveRole,
    ),
  };
}

export function useOnlineQueryGate(): OnlineQueryGate {
  const enabled = useAuthStore((s) => s.canUseOnlineServices());
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const mode = useAuthStore((s) => s.mode);
  const apiKey = useAuthStore((s) => s.apiKey);
  const tenantId = useAuthStore(
    (s) => s.tenantId ?? s.session?.tenantId ?? null,
  );
  const userId = useAuthStore((s) => s.session?.userId ?? null);
  const effectiveRole = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const scopedUserId = mode === "session" ? userId : null;
  const scopedEffectiveRole = mode === "session" ? effectiveRole : null;

  return useMemo(
    () => ({
      enabled,
      baseUrl,
      tenantId,
      userId: scopedUserId,
      effectiveRole: scopedEffectiveRole,
      credentialScope: credentialScope(mode, apiKey),
      canReadOfflineSnapshots: Boolean(
        mode === "session" &&
        baseUrl &&
        tenantId &&
        scopedUserId &&
        scopedEffectiveRole,
      ),
    }),
    [
      apiKey,
      baseUrl,
      enabled,
      mode,
      scopedEffectiveRole,
      scopedUserId,
      tenantId,
    ],
  );
}
