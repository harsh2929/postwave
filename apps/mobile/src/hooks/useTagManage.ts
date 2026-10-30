/**
 * useTagManage — the tag-maintenance mutations + the history feed.
 * Cosmetic edits and group CRUD invalidate the whole tag-catalogue root
 * (colour and grouping are list-render inputs) plus the groups key; the
 * history read is lazy on its sheet.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createTagGroup,
  deleteTagGroup,
  fetchTagHistory,
  updateTag,
  updateTagGroup,
} from "@/api/tagsManage";
import { tagGroupsKey } from "@/hooks/useTagCatalogue";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { parseTagHistory, type TagHistoryView } from "@/lib/tagManage";

export function useTagHistory(tagId: string | null, enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["tag-history", gate.tenantId, tagId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && tagId),
    queryFn: async (): Promise<TagHistoryView> =>
      parseTagHistory(await fetchTagHistory(tagId!)),
  });
}

export function useTagManageWrites() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();

  const settle = () => {
    if (!tenantId) return;
    // The catalogue key's root is ["tags", tenant, ...filters].
    void queryClient.invalidateQueries({ queryKey: ["tags", tenantId] });
    void queryClient.invalidateQueries({ queryKey: tagGroupsKey(tenantId) });
  };

  const edit = useMutation({
    mutationFn: (input: {
      id: string;
      etag: string;
      body: Record<string, unknown>;
    }) => updateTag(input.id, input.etag, input.body),
    onSettled: settle,
  });

  const groupCreate = useMutation({
    mutationFn: (body: Record<string, unknown>) => createTagGroup(body),
    onSettled: settle,
  });

  const groupRename = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      updateTagGroup(input.id, input.body),
    onSettled: settle,
  });

  const groupDelete = useMutation({
    mutationFn: (id: string) => deleteTagGroup(id),
    onSettled: settle,
  });

  return { edit, groupCreate, groupRename, groupDelete };
}
