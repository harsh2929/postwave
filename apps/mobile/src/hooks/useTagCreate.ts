/**
 * useTagCreate — the mutation behind the tags screen's "New tag" sheet.
 *
 * ONLINE-ONLY (no offline outbox): a create is refused with 409 when the
 * name is already registered, and that answer needs the author present to
 * pick a different name — a queued replay would fail silently hours after
 * the operator stopped thinking about it. `api/tags.ts` carries the full
 * rationale.
 *
 * Invalidation: `tagsInvalidationKey(tenantId)` = ["tags", tenantId], a
 * TRUE PREFIX of the catalogue, groups and suggestion keys — so the new
 * tag appears in the chip cloud and the typeahead without a manual
 * refresh. The prefix relationship is pinned in tagCreateDraft.test.ts.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createTag, type CreatedTag } from "@/api/tags";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  buildCreateTagBody,
  tagsInvalidationKey,
  type TagDraft,
} from "@/lib/tagCreateDraft";

export function useTagCreate() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<CreatedTag, unknown, TagDraft>({
    mutationFn: (draft: TagDraft) => createTag(buildCreateTagBody(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: tagsInvalidationKey(gate.tenantId),
      });
    },
  });
}
