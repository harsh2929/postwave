/**
 * useSmsBroadcasts — broadcast draft management for the mobile screen.
 *
 * Reads and writes ride the same admin identity gate as the inbox. Writes are
 * online-only: a draft edit landing after someone else reworked the draft (or
 * after the desktop scheduled it) must conflict loudly (the server 409s
 * non-draft edits), not replay silently from an outbox. Progress is
 * press-driven per broadcast.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  createSmsBroadcast,
  deleteSmsBroadcast,
  getSmsBroadcastProgress,
  listSmsBroadcasts,
  updateSmsBroadcast,
} from "@/api/smsBroadcasts";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SMS_BROADCASTS_KEY,
  useRetireSmsQueries,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";
import type {
  SmsBroadcast,
  SmsBroadcastDraftInput,
} from "@/lib/smsBroadcastWire";

function useWriteControllers(access: SmsInboxAccess) {
  const controllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [access.canRequest, access.identity?.fingerprint],
  );
  return useCallback(async <T>(run: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await run(controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
}

export function useSmsBroadcasts(access: SmsInboxAccess) {
  useRetireSmsQueries(access);
  return useInfiniteQuery({
    queryKey: [
      SMS_BROADCASTS_KEY,
      access.identity?.fingerprint ?? null,
    ] as const,
    enabled: access.canRequest,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await listSmsBroadcasts({
        tenantId: identity.tenantId,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 15_000,
  });
}

export function useSmsBroadcastProgress(
  id: string | null,
  access: SmsInboxAccess,
) {
  useRetireSmsQueries(access);
  return useQuery({
    queryKey: [
      SMS_BROADCASTS_KEY,
      access.identity?.fingerprint ?? null,
      "progress",
      id,
    ] as const,
    enabled: access.canRequest && Boolean(id),
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const progress = await getSmsBroadcastProgress({
        tenantId: identity.tenantId,
        id: id as string,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return progress;
    },
    staleTime: 10_000,
  });
}

export type SmsBroadcastWriteIntent =
  | { action: "create"; draft: SmsBroadcastDraftInput }
  | {
      action: "update";
      id: string;
      draft: SmsBroadcastDraftInput;
      existing: Pick<SmsBroadcast, "listIds" | "segmentId">;
    }
  | { action: "delete"; id: string };

export function useSmsBroadcastWrites(access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<SmsBroadcast | null, Error, SmsBroadcastWriteIntent>({
    mutationKey: [
      "sms-broadcast-write-v1",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const result = await withController<SmsBroadcast | null>(
        async (signal) => {
          if (intent.action === "create") {
            return createSmsBroadcast({
              tenantId: identity.tenantId,
              draft: intent.draft,
              signal,
            });
          }
          if (intent.action === "update") {
            return updateSmsBroadcast({
              tenantId: identity.tenantId,
              id: intent.id,
              draft: intent.draft,
              existing: intent.existing,
              signal,
            });
          }
          await deleteSmsBroadcast({
            tenantId: identity.tenantId,
            id: intent.id,
            signal,
          });
          return null;
        },
      );
      assertCurrentSmsIdentity(identity);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [SMS_BROADCASTS_KEY] });
    },
  });
}
