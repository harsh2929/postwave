/**
 * useListMembership — the list-side membership verbs: search candidates, add
 * them, and take one person off the list.
 *
 * ONLINE-ONLY, both writes, and deliberately NOT the offline outbox:
 *
 *  - the ADD is idempotent server-side and the person-side add IS queueable
 *    (useSubscriberLists, AUDIENCE#33) — but from the LIST side there is
 *    nothing to queue, because you cannot choose who to add without the live
 *    candidate search that names them. A queued add whose candidates could
 *    never be searched would be a button that looks like it worked;
 *  - the REMOVE is a deletion, and the person-side remove is online-only for
 *    the same reason: a removal that lands an hour after the operator changed
 *    their mind is unrecoverable.
 *
 * Both therefore run in network mode "always". The verbs are gated on the auth
 * gate, not on reachability, and react-query's default would PAUSE a write
 * started with no connection and replay it on reconnect; "always" fails it
 * into the caller's onError instead.
 *
 * NOTHING IS PROJECTED OPTIMISTICALLY. DELETE answers 204 even when it removed
 * nothing (removing a non-member is a documented no-op, and a membership still
 * claimed by another source owner survives), so the refreshed roster — not the
 * status code — is what says who is on the list. Both writes invalidate
 * `listCatalogueKey`, the TRUE PREFIX of the catalogue and of every per-list
 * detail key, so the member pages, the header count and the catalogue row all
 * refetch; the touched subscribers' own "lists they are on" card is invalidated
 * by id.
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addListMembers,
  fetchListCandidates,
  removeListMember,
  type ListCandidateSearch,
} from "@/api/listMembership";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { listDetailKey } from "@/hooks/useListDetail";
import { listCatalogueKey } from "@/hooks/useListOptions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";
import {
  isSubscriberUuid,
  removeMemberConfirmCopy,
  type AddMembersResult,
} from "@/lib/listMembershipRows";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { subscriberListsKey } from "@/lib/subscriberQueryKeys";

/** Both routes are editor-floor in apps/api/internal/routeauth/manifest.json. */
export function useCanEditMembership(): boolean {
  const gate = useOnlineQueryGate();
  return canAccessMinimumRole("editor", gate.effectiveRole);
}

function useMembershipInvalidator(): (ids: readonly string[]) => void {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useCallback(
    (ids: readonly string[]) => {
      void queryClient.invalidateQueries({
        queryKey: listCatalogueKey(tenantId),
      });
      for (const id of ids) {
        void queryClient.invalidateQueries({
          queryKey: subscriberListsKey(tenantId, id),
        });
      }
    },
    [queryClient, tenantId],
  );
}

/**
 * Candidates for one query, paired with the membership check for that same
 * query. Structurally disabled until the sheet is open AND something has been
 * typed — the subscriber table is PII, and a sheet that opens must not page
 * through people nobody asked for.
 */
export function useListCandidates(
  listId: string | undefined,
  query: string,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  const q = query.trim();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "candidates", q],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(listId) && open && q !== "",
    queryFn: (): Promise<ListCandidateSearch> => fetchListCandidates(listId!, q),
  });
}

export function useAddListMembers(listId: string | undefined) {
  const invalidate = useMembershipInvalidator();
  return useMutation({
    mutationFn: (ids: readonly string[]): Promise<AddMembersResult | null> =>
      addListMembers(listId!, ids),
    networkMode: "always",
    onSuccess: (_result, ids) => invalidate(ids),
  });
}

/**
 * The row action: confirm naming BOTH the list and the person, then DELETE.
 *
 * Returns `onRemove: undefined` when the verb must not be offered at all —
 * below editor, or while the online gate is closed (the screen's own notice
 * already explains that state, and a write queued from it could not be
 * honoured). A row whose id is not a uuid is refused too: the server 400s a
 * non-uuid `sub_id`, so offering it would be a button that can only fail.
 */
export function useListMemberRemoval(
  listId: string | undefined,
  listName: string,
) {
  const gate = useOnlineQueryGate();
  const canEdit = useCanEditMembership();
  const confirm = useConfirm();
  const { toast } = useToast();
  const invalidate = useMembershipInvalidator();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (subscriberId: string) =>
      removeListMember(listId!, subscriberId),
    networkMode: "always",
  });
  const { mutate } = remove;

  const run = useCallback(
    (member: { id: string; email: string }) => {
      if (!isSubscriberUuid(member.id)) return;
      void (async () => {
        const copy = removeMemberConfirmCopy(listName, member.email);
        const ok = await confirm({
          title: copy.title,
          message: copy.message,
          confirmLabel: copy.confirmLabel,
          destructive: true,
          consequence: copy.consequence,
        });
        if (!ok) return;
        setRemovingId(member.id);
        mutate(member.id, {
          onSuccess: () => {
            haptics.success();
            setRemovingId(null);
            invalidate([member.id]);
            toast({
              kind: "success",
              message: `Removed ${member.email} from “${listName}”.`,
            });
          },
          onError: (error) => {
            haptics.error();
            setRemovingId(null);
            toast({
              kind: "error",
              message:
                errorPresentation(error).message ||
                "Couldn't remove them from this list.",
            });
          },
        });
      })();
    },
    [confirm, invalidate, listName, mutate, toast],
  );

  /**
   * BOTH membership verbs are offered under exactly this condition — same
   * editor floor, same online-only rule — so the add affordance reads it from
   * here rather than re-deriving a second, driftable copy of the same test.
   */
  const canAct = canEdit && gate.enabled && Boolean(listId);
  return {
    onRemove: canAct ? run : undefined,
    removingId,
    canEdit,
    canAct,
  };
}
