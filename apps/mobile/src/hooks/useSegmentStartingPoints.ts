/**
 * useSegmentStartingPoints — the merged preset/template/AI-suggestion
 * catalogue for the segments screen (api/segmentsStartingPoints.ts).
 *
 * `enabled` is caller-driven on top of the online gate: the catalogue is
 * fetched only while the starting-points section is open, because the AI
 * suggestions leg runs live preview counts server-side and firing that on
 * every segments-screen visit would be paying for an answer nobody asked
 * to see.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchSegmentStartingPoints } from "@/api/segmentsStartingPoints";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { segmentsKey } from "@/hooks/useSegments";

export function useSegmentStartingPoints(open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...segmentsKey(gate.tenantId), "starting-points"],
    enabled: gate.enabled && Boolean(gate.tenantId) && open,
    queryFn: () => fetchSegmentStartingPoints(),
  });
}
