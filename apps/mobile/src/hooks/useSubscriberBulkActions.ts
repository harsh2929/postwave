/**
 * useSubscriberBulkActions — the three phone-shaped bulk verbs, wired to the
 * server routes that back them.
 *
 * Wire contract, read off apps/api/internal/subscribers/bulk_operations.go:
 *
 *   POST /api/v1/subscribers/bulk/tag          { subscriber_ids, tag }
 *   POST /api/v1/subscribers/bulk/untag        { subscriber_ids, tag }   (undo)
 *   POST /api/v1/subscribers/bulk/add-to-list  { subscriber_ids, list_id }
 *   POST /api/v1/subscribers/bulk/unsubscribe  { subscriber_ids }
 *
 * The bodies are decoded with `DisallowUnknownFields: true`, so an extra key
 * is a 400 rather than a silently-ignored field. Send exactly these.
 *
 * All four are `apikeys.RequireScope(apikeys.ScopeAdmin)` → owner|admin on a
 * session. The policy that keeps the UI from offering them to anyone else
 * lives in src/lib/subscriberSelection.ts.
 *
 * These are NOT routed through the offline mutation queue. A bulk write
 * replayed hours later would land on the ids the user picked from a list that
 * has since moved — the wrong audience, not a delayed one. The availability
 * rule refuses them offline and says so.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { checkEmailBatch } from "@/api/subscribersValidateEmails";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { listCatalogueKey } from "@/hooks/useListOptions";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";
import type { BulkResultWire } from "@/lib/subscriberSelection";
import {
  parseValidationBatch,
  type ValidationBatchView,
} from "@/lib/subscriberValidateEmails";

async function postBulk(
  path: string,
  body: Record<string, unknown>,
): Promise<BulkResultWire> {
  const { client } = getClient();
  const res = await client.request<unknown>("POST", path, { body });
  // The handler answers `BulkResult`. Anything else is reported as an absent
  // count by lib/subscriberSelection rather than coerced to zero.
  return res && typeof res === "object" ? (res as BulkResultWire) : {};
}

export interface BulkTagInput {
  ids: readonly string[];
  tag: string;
}

export interface BulkAddToListInput {
  ids: readonly string[];
  listId: string;
}

export function useSubscriberBulkActions() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();

  /**
   * Every verb rewrites rows the list is showing, and `affected` alone does
   * not tell us WHICH. Invalidating the subscriber root is the honest move:
   * a projected optimistic patch across an unbounded selection would be a
   * guess repeated N times.
   */
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: subscriberQueryRootKey(tenantId),
    });
  };

  const tag = useMutation({
    mutationFn: (input: BulkTagInput) =>
      postBulk("/api/v1/subscribers/bulk/tag", {
        subscriber_ids: [...input.ids],
        tag: input.tag,
      }),
    onSettled: refresh,
  });

  /** The undo half of `tag` — same audience, same tag, opposite verb. */
  const untag = useMutation({
    mutationFn: (input: BulkTagInput) =>
      postBulk("/api/v1/subscribers/bulk/untag", {
        subscriber_ids: [...input.ids],
        tag: input.tag,
      }),
    onSettled: refresh,
  });

  const addToList = useMutation({
    mutationFn: (input: BulkAddToListInput) =>
      postBulk("/api/v1/subscribers/bulk/add-to-list", {
        subscriber_ids: [...input.ids],
        list_id: input.listId,
      }),
    onSettled: () => {
      refresh();
      // Membership counts live on the list catalogue too.
      void queryClient.invalidateQueries({
        queryKey: listCatalogueKey(tenantId),
      });
    },
  });

  const unsubscribe = useMutation({
    mutationFn: (ids: readonly string[]) =>
      postBulk("/api/v1/subscribers/bulk/unsubscribe", {
        subscriber_ids: [...ids],
      }),
    onSettled: () => {
      refresh();
      // Unsubscribing writes consent + suppression state as well as status.
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    },
  });

  /**
   * Surface validation for the selection's addresses — a READ (the free
   * email_validator, not the billable verification providers), so it neither
   * invalidates any cache nor queues offline.
   */
  const validate = useMutation<ValidationBatchView, Error, string[]>({
    mutationFn: async (emails) => parseValidationBatch(await checkEmailBatch(emails)),
  });

  return {
    tag,
    untag,
    addToList,
    unsubscribe,
    validate,
    pending:
      tag.isPending ||
      untag.isPending ||
      addToList.isPending ||
      unsubscribe.isPending ||
      validate.isPending,
  };
}
