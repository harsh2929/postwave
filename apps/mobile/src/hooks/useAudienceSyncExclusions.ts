/**
 * hooks/useAudienceSyncExclusions.ts — the firewall's forecast for one sync.
 *
 * PRESS-DRIVEN, NEVER PREFETCHED, exactly like `useDestinationPreview` and for
 * the same reason: answering it resolves the whole source audience server-side
 * and runs every member through the consent firewall. That is a real walk of a
 * list or segment, so it happens when a reader asks the question — not every
 * time a sheet opens.
 *
 * `staleTime: 0` because consent and suppression state move underneath it: a
 * re-open re-asks rather than repeating a minutes-old forecast as if it were
 * current.
 *
 * The RECEIPT has no hook: it is a one-shot download into the share sheet, not
 * state anything renders, and caching a CSV of subscriber emails in the
 * persisted query cache would put PII on disk for the sake of a second tap.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchSyncExclusionPreview } from "@/api/audienceSyncExclusions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { SyncExclusionPreview } from "@/lib/audienceSyncExclusions";

export function syncExclusionPreviewQueryKey(
  tenantId: string | null | undefined,
  syncId: string | null,
): readonly unknown[] {
  return ["audience-sync-exclusion-preview", tenantId ?? null, syncId];
}

export function useSyncExclusionPreview(
  syncId: string | null,
  requested: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<SyncExclusionPreview>({
    queryKey: syncExclusionPreviewQueryKey(gate.tenantId, syncId),
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(syncId) && requested,
    staleTime: 0,
    queryFn: () => fetchSyncExclusionPreview(syncId!),
  });
}
