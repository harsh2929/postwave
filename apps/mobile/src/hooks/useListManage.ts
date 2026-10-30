/**
 * useListManage — the list-settings PATCH and the list DELETE.
 *
 * Both invalidate `listCatalogueKey(tenantId)` — the TRUE PREFIX of the
 * catalogue AND every per-list detail key (listDetailKey spreads it), so a
 * rename refreshes the picker, the rows and the open detail header, and a
 * delete drops the dead row instead of leaving a tappable ghost.
 *
 * Online-only by design (see api/listsManage.ts): the PATCH can flip a
 * consent-shaped setting, the DELETE is irreversible — neither may replay
 * from the offline outbox at a moment nobody chose.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteList, updateList } from "@/api/listsManage";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { listCatalogueKey } from "@/hooks/useListOptions";
import type { ListSettingsPatch } from "@/lib/listSettingsForm";

export function useUpdateList() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ListSettingsPatch }) =>
      updateList(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: listCatalogueKey(gate.tenantId),
      });
    },
  });
}

export function useDeleteList() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteList(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: listCatalogueKey(gate.tenantId),
      });
    },
  });
}
