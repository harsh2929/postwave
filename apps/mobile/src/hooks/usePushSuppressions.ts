/** Exact-admin, identity-bound Route43 registry reads and manual removals. */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getClient } from "@/api/sdkClient";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  makeIdentity,
  SmsIdentityRetiredError,
  type SmsInboxAccess,
  type SmsInboxIdentity,
} from "@/hooks/smsInboxIdentity";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { onContextEpochChange, readContextEpoch } from "@/lib/contextEpoch";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  parsePushSuppressionAddReceipt,
  pushSuppressionAddBody,
  pushTokenProblem,
  type PushSuppressionAddInput,
  type PushSuppressionAddReceipt,
} from "@/lib/pushSuppressionAdd";
import {
  isReversibleManualPushSuppression,
  parsePushSuppressionRemovalReceipt,
  parsePushSuppressions,
  PUSH_PLATFORMS,
  type PushPlatform,
  type PushSuppressionRemovalReceipt,
  type PushSuppressionRow,
  type PushSuppressionsPage,
} from "@/lib/pushSuppressions";
import { useAuthStore } from "@/store/auth";

const PUSH_ROOT = "push-suppressions-v2";
const PUSH_PAGE_LIMIT = 100;

export type PushSuppressionAccess = SmsInboxAccess;

export class PushSuppressionWriteRefusedError extends Error {
  readonly code = "push_suppression_write_refused";

  constructor(message: string) {
    super(message);
    this.name = "PushSuppressionWriteRefusedError";
  }
}

export class PushSuppressionOutcomeUnknownError extends Error {
  readonly code = "push_suppression_outcome_unknown";

  constructor() {
    super(
      "Manual registry removal outcome unknown. Reload the exact row in the original workspace before retrying.",
    );
    this.name = "PushSuppressionOutcomeUnknownError";
  }
}

export function usePushSuppressionAccess(
  focused = true,
): PushSuppressionAccess {
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const mode = useAuthStore((state) => state.mode);
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  useEffect(() => onContextEpochChange((epoch) => setContextEpoch(epoch)), []);
  const roleAllowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const identity = useMemo(
    () =>
      makeIdentity({
        baseUrl: gate.baseUrl,
        tenantId: gate.tenantId,
        userId: gate.userId,
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
    ],
  );
  const sessionReady = gate.enabled && Boolean(identity);
  return {
    identity,
    roleAllowed,
    online,
    sessionReady,
    canRequest: focused && online && sessionReady && roleAllowed,
    denialReason: roleAllowed
      ? null
      : mode === "api_key"
        ? "The customer push registry requires an owner or admin session; mobile API-key scopes are not exposed."
        : "The customer push registry is restricted to workspace owners and admins.",
  };
}

function pushKey(fingerprint: string | null, platform: PushPlatform | "all") {
  return [PUSH_ROOT, fingerprint, platform] as const;
}

function useRetirePushQueries(
  access: PushSuppressionAccess,
  key: readonly unknown[],
): void {
  const client = useQueryClient();
  const previous = useRef(access.identity?.fingerprint ?? null);
  useEffect(() => {
    const fingerprint = access.identity?.fingerprint ?? null;
    const isPush = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === PUSH_ROOT;
    if (
      !access.roleAllowed ||
      !access.identity ||
      previous.current !== fingerprint
    ) {
      void client.cancelQueries({ predicate: isPush });
      client.removeQueries({ predicate: isPush });
    } else if (!access.canRequest) {
      void client.cancelQueries({ queryKey: key, exact: true });
    }
    previous.current = fingerprint;
    return () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [access.canRequest, access.identity, access.roleAllowed, client, key]);
}

export function usePushSuppressions(
  platformValue: string,
  access: PushSuppressionAccess,
) {
  const platform =
    platformValue === "all"
      ? "all"
      : PUSH_PLATFORMS.includes(platformValue as PushPlatform)
        ? (platformValue as PushPlatform)
        : null;
  const key = useMemo(
    () => pushKey(access.identity?.fingerprint ?? null, platform ?? "all"),
    [access.identity?.fingerprint, platform],
  );
  const latestScope = `${access.identity?.fingerprint ?? ""}|${platform ?? "invalid"}`;
  const latestScopeRef = useRef(latestScope);
  latestScopeRef.current = latestScope;
  useRetirePushQueries(access, key);
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: access.canRequest && platform !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<PushSuppressionsPage> => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      if (latestScopeRef.current !== latestScope || platform === null)
        throw new SmsIdentityRetiredError();
      const { client } = getClient();
      const raw = await client.request<unknown>(
        "GET",
        "/api/v1/push/suppressions",
        {
          query: {
            limit: PUSH_PAGE_LIMIT,
            ...(platform === "all" ? {} : { platform }),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          signal,
        },
      );
      const page = parsePushSuppressions(
        raw,
        identity.tenantId,
        PUSH_PAGE_LIMIT,
        platform === "all" ? undefined : platform,
      );
      assertCurrentSmsIdentity(identity);
      if (latestScopeRef.current !== latestScope)
        throw new SmsIdentityRetiredError();
      return page;
    },
    getNextPageParam: (page) => page.nextCursor,
  });
  return { ...query, access };
}

function responseStatus(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) return 0;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : 0;
}

async function freshIdentity(
  access: PushSuppressionAccess,
): Promise<SmsInboxIdentity> {
  if (!isProbablyOnline()) {
    throw new PushSuppressionWriteRefusedError(
      "Registry changes need a connection and are never queued for later.",
    );
  }
  const identity = identityOrThrow(access.canRequest, access.identity);
  await useAuthStore.getState().refreshSessionFromServer();
  assertCurrentSmsIdentity(identity);
  return identity;
}

export function useRemovePushSuppression(access: PushSuppressionAccess) {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => controller.current?.abort(),
    [access.identity?.fingerprint],
  );
  return useMutation({
    mutationKey: [
      "push-suppression-remove-v2",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (
      row: PushSuppressionRow,
    ): Promise<PushSuppressionRemovalReceipt> => {
      if (inFlight.current)
        throw new PushSuppressionWriteRefusedError(
          "A registry change is already in progress.",
        );
      if (!isReversibleManualPushSuppression(row)) {
        throw new PushSuppressionWriteRefusedError(
          "Only a reversible manual dashboard authority can be removed here.",
        );
      }
      inFlight.current = true;
      try {
        const identity = await freshIdentity(access);
        if (row.tenantId !== identity.tenantId)
          throw new SmsIdentityRetiredError();
        controller.current = new AbortController();
        let raw: unknown;
        try {
          const { client } = getClient();
          raw = await client.request<unknown>(
            "DELETE",
            `/api/v1/push/suppressions/${encodeURIComponent(row.id)}`,
            {
              body: { expected_version: row.version },
              signal: controller.current.signal,
            },
          );
        } catch (error: unknown) {
          const status = responseStatus(error);
          if (status >= 400 && status < 500) throw error;
          throw new PushSuppressionOutcomeUnknownError();
        }
        let receipt: PushSuppressionRemovalReceipt;
        try {
          receipt = parsePushSuppressionRemovalReceipt(raw, {
            tenantId: identity.tenantId,
            id: row.id,
            version: row.version,
          });
        } catch {
          throw new PushSuppressionOutcomeUnknownError();
        }
        try {
          assertCurrentSmsIdentity(identity);
        } catch {
          throw new PushSuppressionWriteRefusedError(
            "The server confirmed the change before your workspace identity changed. Verify the original workspace before relying on this screen.",
          );
        }
        return receipt;
      } finally {
        controller.current = null;
        inFlight.current = false;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [PUSH_ROOT, access.identity?.fingerprint ?? null],
      });
    },
  });
}

/**
 * Manually suppress a device token (POST /api/v1/push/suppressions,
 * exact-admin) — desktop's add-by-token verb (PushSuppressions.tsx), now on
 * the phone via paste.
 *
 * Same discipline as removal: online-only and identity-revalidated before the
 * write, single-flight, and the answered row is VERIFIED to be this tenant's
 * own manual dashboard authority before the screen may claim "suppressed"
 * (lib/pushSuppressionAdd.ts). Client-side token validation is the operator's
 * early feedback; the handler's byte rules remain the authority. A 4xx keeps
 * its own sentence; a transport failure after dispatch reads as
 * outcome-unknown, never as success.
 */
export function useAddPushSuppression(access: PushSuppressionAccess) {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  return useMutation({
    mutationKey: [
      "push-suppression-add-v2",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (
      input: PushSuppressionAddInput,
    ): Promise<PushSuppressionAddReceipt> => {
      if (inFlight.current)
        throw new PushSuppressionWriteRefusedError(
          "A registry change is already in progress.",
        );
      const problem = pushTokenProblem(input.deviceToken);
      if (problem) throw new PushSuppressionWriteRefusedError(problem);
      inFlight.current = true;
      try {
        const identity = await freshIdentity(access);
        let raw: unknown;
        try {
          const { client } = getClient();
          raw = await client.request<unknown>(
            "POST",
            "/api/v1/push/suppressions",
            { body: pushSuppressionAddBody(input) },
          );
        } catch (error: unknown) {
          const status = responseStatus(error);
          if (status >= 400 && status < 500) throw error;
          throw new PushSuppressionOutcomeUnknownError();
        }
        const receipt = parsePushSuppressionAddReceipt(raw, {
          tenantId: identity.tenantId,
          platform: input.platform,
        });
        try {
          assertCurrentSmsIdentity(identity);
        } catch {
          throw new PushSuppressionWriteRefusedError(
            "The server confirmed the change before your workspace identity changed. Verify the original workspace before relying on this screen.",
          );
        }
        return receipt;
      } finally {
        inFlight.current = false;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [PUSH_ROOT, access.identity?.fingerprint ?? null],
      });
    },
  });
}
