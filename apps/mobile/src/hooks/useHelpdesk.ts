/** Identity-scoped, exact-admin Helpdesk queries and internal-state mutations. */
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  claimHelpdeskConversation,
  fetchHelpdeskCatalog,
  fetchHelpdeskConversation,
  helpdeskVersionedMutationOutcomeIsAmbiguous,
  listHelpdeskConversations,
  listHelpdeskMessages,
  recordHelpdeskInternalNote,
  setHelpdeskConversationStatus,
  type HelpdeskConversationResource,
  type HelpdeskInternalNoteReceipt,
} from "@/api/serviceSuite";
import {
  HELPDESK_CATALOG_KEY,
  HELPDESK_CONVERSATION_KEY,
  HELPDESK_QUEUE_KEY,
  HELPDESK_THREAD_KEY,
  assertCurrentHelpdeskIdentity,
  helpdeskIdentityKey,
  identityOrThrow,
  reauthorizeHelpdeskIdentity,
  HelpdeskIdentityRetiredError,
  type HelpdeskAccess,
  type HelpdeskIdentity,
} from "@/hooks/useHelpdeskIdentity";
import {
  normalizeHelpdeskId,
  type HelpdeskCatalog,
  type HelpdeskConversationPage,
  type HelpdeskMessagePage,
} from "@/lib/helpdesk";

/** The latest-window poll. Paused as soon as an older page is loaded. */
export const HELPDESK_THREAD_POLL_MS = 10_000;

// The identity half of this hook family lives in `useHelpdeskIdentity`; it
// stays reachable from here because every caller treats "the Helpdesk hooks"
// as one module.
export {
  HELPDESK_CATALOG_KEY,
  HELPDESK_CONVERSATION_KEY,
  HELPDESK_QUEUE_KEY,
  HELPDESK_THREAD_KEY,
  HelpdeskIdentityRetiredError,
  assertCurrentHelpdeskIdentity,
  makeHelpdeskIdentity,
  reauthorizeHelpdeskIdentity,
  useHelpdeskAccess,
} from "@/hooks/useHelpdeskIdentity";
export type {
  HelpdeskAccess,
  HelpdeskIdentity,
} from "@/hooks/useHelpdeskIdentity";

export function useHelpdeskConversations(
  status: string | null,
  access: HelpdeskAccess,
) {
  const client = useQueryClient();
  const key = useMemo(
    () =>
      [
        HELPDESK_QUEUE_KEY,
        ...helpdeskIdentityKey(access.identity),
        status ?? "all",
      ] as const,
    [access.identity, status],
  );
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: access.onlineGate.enabled && access.canRequest,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({
      pageParam,
      signal,
    }): Promise<HelpdeskConversationPage> => {
      const identity = identityOrThrow(access);
      const page = await listHelpdeskConversations({
        ...(status ? { status } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentHelpdeskIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    staleTime: 15_000,
  });
  const refreshFirstPage = useCallback(
    () => client.resetQueries({ queryKey: key, exact: true }),
    [client, key],
  );
  return { ...query, refreshFirstPage };
}

export function useHelpdeskConversation(id: string, access: HelpdeskAccess) {
  const canonicalId = normalizeHelpdeskId(id);
  return useQuery({
    queryKey: [
      HELPDESK_CONVERSATION_KEY,
      ...helpdeskIdentityKey(access.identity),
      canonicalId,
    ],
    enabled:
      access.onlineGate.enabled && access.canRequest && Boolean(canonicalId),
    queryFn: async ({ signal }): Promise<HelpdeskConversationResource> => {
      const identity = identityOrThrow(access);
      if (!canonicalId) throw new HelpdeskIdentityRetiredError();
      const conversation = await fetchHelpdeskConversation(canonicalId, {
        signal,
      });
      assertCurrentHelpdeskIdentity(identity);
      return conversation;
    },
  });
}

export function useHelpdeskThread(id: string, access: HelpdeskAccess) {
  const client = useQueryClient();
  const canonicalId = normalizeHelpdeskId(id);
  const key = useMemo(
    () =>
      [
        HELPDESK_THREAD_KEY,
        ...helpdeskIdentityKey(access.identity),
        canonicalId,
      ] as const,
    [access.identity, canonicalId],
  );
  const query = useInfiniteQuery({
    queryKey: key,
    enabled:
      access.onlineGate.enabled && access.canRequest && Boolean(canonicalId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<HelpdeskMessagePage> => {
      const identity = identityOrThrow(access);
      if (!canonicalId) throw new HelpdeskIdentityRetiredError();
      const page = await listHelpdeskMessages(canonicalId, {
        order: "desc",
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentHelpdeskIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: (current) => {
      const data = current.state.data as
        | InfiniteData<HelpdeskMessagePage, string | undefined>
        | undefined;
      return data && data.pages.length > 1 ? false : HELPDESK_THREAD_POLL_MS;
    },
  });
  const refreshLatest = useCallback(
    () => client.resetQueries({ queryKey: key, exact: true }),
    [client, key],
  );
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  return { ...query, refreshLatest };
}

export function useHelpdeskCatalog(access: HelpdeskAccess) {
  return useQuery({
    queryKey: [HELPDESK_CATALOG_KEY, ...helpdeskIdentityKey(access.identity)],
    enabled: access.onlineGate.enabled && access.canRequest,
    staleTime: 30 * 60_000,
    queryFn: async ({ signal }): Promise<HelpdeskCatalog> => {
      const identity = identityOrThrow(access);
      const catalog = await fetchHelpdeskCatalog({ signal });
      assertCurrentHelpdeskIdentity(identity);
      return catalog;
    },
  });
}

function useMutationController(identityFingerprint: string | null): {
  next: () => AbortSignal;
} {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [identityFingerprint]);
  return {
    next: () => {
      controller.current?.abort();
      controller.current = new AbortController();
      return controller.current.signal;
    },
  };
}

export function useHelpdeskInternalNote(id: string, access: HelpdeskAccess) {
  const client = useQueryClient();
  const requests = useMutationController(
    access.canRequest ? (access.identity?.fingerprint ?? null) : null,
  );
  return useMutation<
    HelpdeskInternalNoteReceipt,
    Error,
    { body: string; idempotencyKey: string }
  >({
    mutationKey: [
      "helpdesk-internal-note-v2",
      ...helpdeskIdentityKey(access.identity),
      id,
    ],
    mutationFn: async ({ body, idempotencyKey }) => {
      const identity = identityOrThrow(access);
      await reauthorizeHelpdeskIdentity(identity);
      const receipt = await recordHelpdeskInternalNote(
        id,
        body,
        idempotencyKey,
        {
          signal: requests.next(),
        },
      );
      assertCurrentHelpdeskIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      void client.resetQueries({
        queryKey: [
          HELPDESK_THREAD_KEY,
          ...helpdeskIdentityKey(access.identity),
          id,
        ],
        exact: true,
      });
      void client.invalidateQueries({ queryKey: [HELPDESK_QUEUE_KEY] });
    },
  });
}

export function useHelpdeskStatusChange(id: string, access: HelpdeskAccess) {
  const client = useQueryClient();
  const requests = useMutationController(
    access.canRequest ? (access.identity?.fingerprint ?? null) : null,
  );
  return useMutation<
    HelpdeskConversationResource,
    Error,
    { status: string; ifMatch: string; expectedVersion: string }
  >({
    mutationKey: [
      "helpdesk-status-v2",
      ...helpdeskIdentityKey(access.identity),
      id,
    ],
    mutationFn: async ({ status, ifMatch, expectedVersion }) => {
      const identity = identityOrThrow(access);
      await reauthorizeHelpdeskIdentity(identity);
      const updated = await setHelpdeskConversationStatus(id, status, {
        ifMatch,
        expectedVersion,
        signal: requests.next(),
      });
      assertCurrentHelpdeskIdentity(identity);
      return updated;
    },
    onSuccess: (updated) => {
      client.setQueryData(
        [
          HELPDESK_CONVERSATION_KEY,
          ...helpdeskIdentityKey(access.identity),
          id,
        ],
        updated,
      );
      void client.invalidateQueries({ queryKey: [HELPDESK_QUEUE_KEY] });
    },
    onError: (error) => {
      if (
        isHelpdeskPreconditionError(error) ||
        helpdeskVersionedMutationOutcomeIsAmbiguous(error)
      ) {
        refreshHelpdeskStateAfterUncertainWrite(client, access.identity, id);
      }
    },
  });
}

export function useHelpdeskAssignment(id: string, access: HelpdeskAccess) {
  const client = useQueryClient();
  const requests = useMutationController(
    access.canRequest ? (access.identity?.fingerprint ?? null) : null,
  );
  return useMutation<
    HelpdeskConversationResource,
    Error,
    {
      action: "assign_self" | "unassign";
      ifMatch: string;
      expectedVersion: string;
      reason?: string;
    }
  >({
    mutationKey: [
      "helpdesk-assignment-v2",
      ...helpdeskIdentityKey(access.identity),
      id,
    ],
    mutationFn: async ({ action, ifMatch, expectedVersion, reason }) => {
      const identity = identityOrThrow(access);
      await reauthorizeHelpdeskIdentity(identity);
      const updated = await claimHelpdeskConversation(id, action, {
        ifMatch,
        expectedVersion,
        ...(reason ? { reason } : {}),
        signal: requests.next(),
      });
      assertCurrentHelpdeskIdentity(identity);
      return updated;
    },
    onSuccess: (updated) => {
      client.setQueryData(
        [
          HELPDESK_CONVERSATION_KEY,
          ...helpdeskIdentityKey(access.identity),
          id,
        ],
        updated,
      );
      void client.invalidateQueries({ queryKey: [HELPDESK_QUEUE_KEY] });
    },
    onError: (error) => {
      if (
        isHelpdeskPreconditionError(error) ||
        helpdeskVersionedMutationOutcomeIsAmbiguous(error)
      ) {
        refreshHelpdeskStateAfterUncertainWrite(client, access.identity, id);
      }
    },
  });
}

function refreshHelpdeskStateAfterUncertainWrite(
  client: QueryClient,
  identity: HelpdeskIdentity | null,
  id: string,
): void {
  const detail = {
    queryKey: [HELPDESK_CONVERSATION_KEY, ...helpdeskIdentityKey(identity), id],
    exact: true,
  } as const;
  // Cancel first so a stale in-flight GET cannot repopulate the revision after
  // it is discarded. Cache maintenance must never create a second write.
  void (async () => {
    try {
      await client.cancelQueries(detail);
    } finally {
      await client.resetQueries(detail);
    }
  })().catch(() => undefined);
  void client.invalidateQueries({ queryKey: [HELPDESK_QUEUE_KEY] });
}

function isHelpdeskPreconditionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const tagged = error as { status?: unknown; code?: unknown };
  return (
    tagged.status === 412 ||
    tagged.status === 428 ||
    tagged.code === "precondition_failed" ||
    tagged.code === "precondition_required"
  );
}
