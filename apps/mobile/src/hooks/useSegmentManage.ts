/**
 * useSegmentManage — DELETE /api/v1/segments/{id} (editor; online-only —
 * see api/segmentsManage.ts). Invalidates the `segmentsKey` root: the TRUE
 * PREFIX of the catalogue, the detail, and the size-history keys, so the
 * dead segment vanishes everywhere at once.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteSegment } from "@/api/segmentsManage";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { segmentsKey } from "@/hooks/useSegments";

export function useDeleteSegment() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSegment(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: segmentsKey(gate.tenantId),
      });
    },
  });
}
