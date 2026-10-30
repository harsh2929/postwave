/**
 * useSubscriberLists — the lists a subscriber currently belongs to, plus the
 * two membership writes (add and remove), both optimistic.
 *
 * Mobile could already PUSH someone into a list (AddToListModal) but never
 * showed which lists they were in, so the picker reported "Added ✓" for a
 * membership that already existed and the profile could never answer "why
 * is this person getting this email?". The endpoint and the SDK method both
 * already existed and had zero call sites:
 *
 *   GET    /api/v1/lists/for-subscriber/{sub_id}   → client.lists.forSubscriber
 *   POST   /api/v1/lists/{id}/subscribers          → raw client.request
 *   DELETE /api/v1/lists/{id}/subscribers/{sub_id} → raw client.request
 *
 * Neither read path is in openapi.json even though both are mounted in Go
 * (apps/api/internal/lists/lists.go), so do not expect a generated client
 * to cover them.
 *
 * ADD lives here rather than in useSubscribers.ts so that both directions of
 * the same membership row are projected against the same cache key from the
 * same module — they used to disagree, and only removal was instant.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { listCatalogueKey } from "@/hooks/useListOptions";
import { offlineSafeMutationMeta } from "@/lib/queryClient";
import { executeEntityWrite } from "@/lib/offlineEntityWrite";
import type { EntityWriteVars } from "@/lib/offlineEntityWriteContract";
import { newOfflineMutationMetadata } from "@/lib/offlineMutations";
import { OFFLINE_MUTATION_KEYS } from "@/lib/offlineMutationContract";
import {
  appendRowIfAbsent,
  optimisticTriad,
  removeRowById,
} from "@/lib/optimisticQueries";
import { type SubscriberListMembership } from "@/lib/optimisticWrites";
import {
  subscriberListsKey,
  subscriberMutationInvalidationKeys,
} from "@/lib/subscriberQueryKeys";

export type { SubscriberListMembership } from "@/lib/optimisticWrites";
export { subscriberListsKey } from "@/lib/subscriberQueryKeys";

/**
 * The server rejects a non-UUID `sub_id` with 400 bad_id. The subscribers
 * list falls back to the EMAIL as a route param for rows that arrive
 * without an id, so guard here rather than firing a request that can only
 * fail.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isSubscriberUuid(id: string | undefined | null): boolean {
  return typeof id === "string" && UUID_RE.test(id.trim());
}

export function normalizeMemberships(res: unknown): SubscriberListMembership[] {
  const items = (res as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: SubscriberListMembership[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { id?: unknown; name?: unknown };
    if (row.id == null) continue;
    out.push({
      id: String(row.id),
      name: typeof row.name === "string" && row.name ? row.name : String(row.id),
    });
  }
  return out;
}

export function useSubscriberLists(id: string | undefined) {
  const gate = useOnlineQueryGate();
  const usable = isSubscriberUuid(id);
  return useQuery({
    queryKey: subscriberListsKey(gate.tenantId, id),
    enabled: gate.enabled && Boolean(gate.tenantId) && usable,
    queryFn: async (): Promise<SubscriberListMembership[]> => {
      const { client } = getClient();
      return normalizeMemberships(await client.lists.forSubscriber(id!));
    },
  });
}

type RawRequestClient = {
  request: (
    method: string,
    path: string,
    options?: { body: unknown },
  ) => Promise<unknown>;
};

/** DELETE the membership row. Idempotent: removing twice is a no-op 200. */
export function removeSubscriberFromList(
  client: unknown,
  listId: string | number,
  subscriberId: string,
): Promise<unknown> {
  const raw = client as RawRequestClient;
  return raw.request(
    "DELETE",
    `/api/v1/lists/${encodeURIComponent(String(listId))}/subscribers/${encodeURIComponent(subscriberId)}`,
  );
}

/**
 * Use the list-scoped membership endpoint because it accepts both Moosewave
 * UUIDs and Listmonk bigint list IDs and resolves the latter through
 * `list_id_map`. The subscriber bulk endpoint accepts only a UUID list id.
 */
export function addSubscriberToList(
  client: unknown,
  subscriberId: string,
  listId: string | number,
): Promise<unknown> {
  const raw = client as RawRequestClient;
  return raw.request(
    "POST",
    `/api/v1/lists/${encodeURIComponent(String(listId))}/subscribers`,
    { body: { subscriber_ids: [subscriberId] } },
  );
}

/**
 * Everything a membership change can move: the memberships card, the
 * catalogue's per-list counts, and the subscriber's own list/detail/timeline
 * queries.
 */
function useMembershipInvalidator(): (subscriberId: string) => void {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return (subscriberId: string) => {
    void queryClient.invalidateQueries({
      queryKey: subscriberListsKey(tenantId, subscriberId),
    });
    // Membership changes move the catalogue's per-list counts too.
    void queryClient.invalidateQueries({ queryKey: listCatalogueKey(tenantId) });
    if (!tenantId) return;
    for (const queryKey of subscriberMutationInvalidationKeys(
      tenantId,
      subscriberId,
    )) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}

/**
 * Remove a subscriber from one list, optimistically. The row disappears
 * immediately and is restored verbatim if the DELETE fails, which is what
 * makes an undo toast honest rather than decorative.
 */
export function useRemoveSubscriberFromList() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  const invalidate = useMembershipInvalidator();
  return useMutation({
    mutationFn: async (input: { subscriberId: string; listId: string }) => {
      const { client } = getClient();
      return removeSubscriberFromList(client, input.listId, input.subscriberId);
    },
    ...optimisticTriad<
      SubscriberListMembership[],
      { subscriberId: string; listId: string }
    >(
      queryClient,
      (input) => subscriberListsKey(tenantId, input.subscriberId) as unknown[],
      (rows, input) => removeRowById(rows, input.listId),
    ),
    onSettled: (_data, _err, input) => invalidate(input.subscriberId),
  });
}

/** The membership-add path, built once so the queue and the test agree. */
export function addSubscriberToListPath(listId: string | number): string {
  return `/api/v1/lists/${encodeURIComponent(String(listId))}/subscribers`;
}

/**
 * Recover the two ids from a QUEUED entity write.
 *
 * The optimistic projection has to work from the persisted variables and
 * nothing else: a queued add is rehydrated from disk by a later process, where
 * the {id, listId} the screen passed no longer exists. Deriving them from the
 * path and body — the only things that survive — is what keeps the projection
 * and the replay describing the same write. Both are pure and exported so the
 * derivation is tested rather than assumed.
 */
export function listIdFromAddPath(path: string): string | null {
  const match = /^\/api\/v1\/lists\/([^/]+)\/subscribers$/.exec(path ?? "");
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function subscriberIdFromAddBody(body: unknown): string | null {
  const ids = (body as { subscriber_ids?: unknown } | null)?.subscriber_ids;
  if (!Array.isArray(ids)) return null;
  const first = ids[0];
  return typeof first === "string" && first ? first : null;
}

/**
 * useAddSubscriberToList — add a single subscriber to a list, optimistically,
 * and QUEUEABLE OFFLINE (AUDIENCE#33).
 *
 * Every audience write on mobile used to hard-return while offline, so the one
 * thing you do at a conference stand with no signal — put the person you just
 * met on a list — was the one thing the phone refused. It now goes through the
 * generic entity-write queue, which means:
 *
 *   - offline, TanStack pauses the mutation, the persister writes it to the
 *     encrypted vault, and it replays on reconnect;
 *   - the `operationId` travels as the Idempotency-Key; and
 *   - `lib/offlineQueueSafety.ts` re-checks the route at REPLAY time.
 *
 * This is safe to replay LATE specifically because the handler only adds:
 * `lists.AddSubscribers` (membership_write.go:111) calls `AddMembers` and
 * nothing else, and the route is documented as idempotent by construction. The
 * matching REMOVE deliberately stays online-only — a deletion that lands an
 * hour after the user changed their mind is unrecoverable.
 */
export function useAddSubscriberToList() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  const invalidate = useMembershipInvalidator();
  // The catalogue the picker was chosen from is already cached, so the new
  // row can carry its real name. The id is the honest fallback — it is
  // exactly what normalizeMemberships uses for a nameless list — and the
  // refetch in onSettled replaces the projection either way.
  //
  // Read by PREFIX, and off `.rows`. This used to call `getQueryData` with a
  // hand-built exact key and type the result as an array; the catalogue query
  // has always resolved to `{rows, total}`, so `catalogue.find` was not a
  // function whenever the catalogue was actually cached — a throw inside
  // onMutate, i.e. exactly the optimistic path this exists to serve. The key
  // has also since grown identity segments, which an exact-match lookup would
  // silently miss.
  const resolveName = (listId: string): string => {
    const entries = queryClient.getQueriesData<{
      rows?: { id: string; name: string }[];
    }>({ queryKey: [...listCatalogueKey(tenantId), "options"] });
    for (const [, data] of entries) {
      const match = data?.rows?.find((row) => row.id === listId);
      if (match?.name) return match.name;
    }
    return listId;
  };
  const inner = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.entityWrite,
    meta: offlineSafeMutationMeta,
    mutationFn: executeEntityWrite,
    ...optimisticTriad<SubscriberListMembership[], EntityWriteVars>(
      queryClient,
      (vars) =>
        subscriberListsKey(
          tenantId,
          subscriberIdFromAddBody(vars.body) ?? undefined,
        ) as unknown[],
      (rows, vars) => {
        const listId = listIdFromAddPath(vars.path);
        if (!listId) return rows;
        return appendRowIfAbsent(rows, {
          id: listId,
          name: resolveName(listId),
        });
      },
    ),
    onSettled: (_data, _err, vars) => {
      const id = subscriberIdFromAddBody(vars.body);
      if (id) invalidate(id);
    },
  });

  // The screen still speaks in {id, listId}; the queue needs a verb, a path
  // and a body it can replay from disk. The second argument is forwarded
  // verbatim so the caller keeps its per-call onSuccess/onError.
  const mutate = (
    input: { id: string; listId: string | number },
    options?: Parameters<typeof inner.mutate>[1],
  ) => {
    inner.mutate(
      {
        ...newOfflineMutationMetadata(),
        method: "POST",
        path: addSubscriberToListPath(input.listId),
        body: { subscriber_ids: [input.id] },
        invalidateRoots: ["lists", "subs"],
        label: "Add to list",
      },
      options,
    );
  };

  return { ...inner, mutate };
}
