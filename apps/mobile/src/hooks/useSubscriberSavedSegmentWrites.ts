/**
 * useSubscriberSavedSegmentWrites — create and delete saved-audience
 * bookmarks from the phone (the read stays in hooks/useSavedSegments.ts).
 *
 * Both routes are editor-scoped (`POST/DELETE /api/v1/segments/saved`,
 * routeauth manifest family:subscribers); the UI gates on the same floor so
 * a viewer never sees a verb that would 403.
 *
 * ONLINE-ONLY: a bookmark names the view the operator is looking at NOW; a
 * create replayed from an offline queue hours later would bookmark a search
 * they have since abandoned, under a name they chose for a different moment.
 *
 * After a create the new segment is PREVIEWED once (editor route) so its
 * chip carries a member count instead of an em-dash. That stamp is
 * best-effort: the bookmark exists either way, and reporting a failed count
 * as a failed save would be a lie in the scary direction.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  createSavedSegment,
  deleteSavedSegment,
  previewSavedSegment,
  type CreateSavedSegmentInput,
} from "@/api/subscribersSavedSegments";
import { savedSegmentsKey } from "@/hooks/useSavedSegments";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useCreateSavedSegment() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: CreateSavedSegmentInput): Promise<string> => {
      const id = await createSavedSegment(input);
      if (id) {
        // Count stamp only — see module doc. The refresh below re-reads the
        // list either way.
        try {
          await previewSavedSegment(id);
        } catch {
          /* the bookmark exists; the badge will say "not evaluated yet" */
        }
      }
      return id;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: savedSegmentsKey(tenantId),
      });
    },
  });
}

export function useDeleteSavedSegment() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: string) => deleteSavedSegment(id),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: savedSegmentsKey(tenantId),
      });
    },
  });
}
